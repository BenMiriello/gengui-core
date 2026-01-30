/**
 * Text analysis stream consumer.
 * Orchestrates document analysis and node updates via Redis streams.
 */
import { db } from '../config/database';
import { documents } from '../models/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import type { StreamMessage } from './redis-streams';
import { analyzeText, updateNodes } from './gemini';
import { storyNodesRepository, parsePassages } from './storyNodes';
import { BlockingConsumer } from '../lib/blocking-consumer';
import type { ExistingNode } from '../types/storyNodes';

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 50000;

class TextAnalysisConsumer extends BlockingConsumer {
  constructor() {
    super('text-analysis-service');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('text-analysis:stream', 'text-analysis-processors');
  }

  protected async consumeLoop(): Promise<void> {
    const consumerName = `text-analysis-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(
          'text-analysis:stream',
          'text-analysis-processors',
          consumerName,
          { block: 2000, count: 1 }
        );

        if (result) {
          await this.handleMessage(result);
        }
      } catch (error: any) {
        // Shutdown in progress - exit gracefully
        if (!this.isRunning) break;

        // Redis disconnected during shutdown
        if (error?.message?.includes('Connection') || error?.code === 'ERR_CONNECTION_CLOSED') {
          break;
        }

        logger.error({ error }, 'Error in text analysis consumer loop');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleMessage(message: StreamMessage) {
    const { documentId, userId, reanalyze, updateMode } = message.data;

    if (!documentId || !userId) {
      logger.error({ data: message.data }, 'Request missing documentId or userId');
      await this.ack(message.id);
      return;
    }

    try {
      if (updateMode === 'true') {
        await this.handleUpdate(documentId, userId);
      } else {
        await this.handleAnalyze(documentId, userId, reanalyze === 'true');
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Operation failed. Please try again.';
      logger.error({ error, documentId, errorMessage }, 'Text analysis failed');

      const eventType = updateMode === 'true' ? 'update-failed' : 'analysis-failed';
      this.broadcast(documentId, eventType, { error: errorMessage });
    }

    await this.ack(message.id);
  }

  private async handleAnalyze(documentId: string, userId: string, reanalyze: boolean) {
    logger.info({ documentId, userId, reanalyze }, 'Processing text analysis request');

    const document = await this.fetchAndValidateDocument(documentId, userId, 'analysis-failed');
    if (!document) return;

    // Call Gemini
    logger.info({ documentId, contentLength: document.content.length }, 'Calling Gemini API');
    const analysis = await analyzeText(document.content);

    // Delete existing if reanalyze
    if (reanalyze) {
      logger.info({ documentId }, 'Re-analyzing: deleting existing nodes');
      await storyNodesRepository.deleteAllForDocument(documentId, userId);
    }

    // Create nodes, connections, and narrative threads (inherit document style)
    const nodeNameToId = await storyNodesRepository.createNodes({
      userId,
      documentId,
      nodes: analysis.nodes,
      connections: analysis.connections,
      narrativeThreads: analysis.narrativeThreads,
      documentContent: document.content,
      documentStyle: {
        preset: document.defaultStylePreset,
        prompt: document.defaultStylePrompt,
      },
    });

    this.broadcast(documentId, 'analysis-complete', {
      nodesCount: nodeNameToId.size,
      connectionsCount: analysis.connections.length,
    });

    logger.info(
      { documentId, nodesCount: nodeNameToId.size, connectionsCount: analysis.connections.length },
      'Text analysis completed successfully'
    );
  }

  private async handleUpdate(documentId: string, userId: string) {
    logger.info({ documentId, userId }, 'Processing node update request');

    const document = await this.fetchAndValidateDocument(documentId, userId, 'update-failed');
    if (!document) return;

    // Fetch existing nodes
    const existingDbNodes = await storyNodesRepository.getActiveNodes(documentId, userId);

    if (existingDbNodes.length === 0) {
      logger.info({ documentId }, 'No existing nodes to update');
      this.broadcast(documentId, 'update-failed', {
        error: 'No existing nodes to update. Use Analyze instead.',
      });
      return;
    }

    // Convert to format for Gemini
    const existingNodes: ExistingNode[] = existingDbNodes.map(n => ({
      id: n.id,
      type: n.type,
      name: n.name,
      description: n.description || '',
      passages: parsePassages(n.passages),
    }));

    // Call Gemini
    logger.info({ documentId, existingNodeCount: existingNodes.length }, 'Calling Gemini updateNodes');
    const updates = await updateNodes(document.content, existingNodes);

    // Apply updates (new nodes inherit document style)
    const result = await storyNodesRepository.applyUpdates({
      userId,
      documentId,
      documentContent: document.content,
      existingNodes: existingDbNodes.map(n => ({ id: n.id, name: n.name })),
      updates,
      documentStyle: {
        preset: document.defaultStylePreset,
        prompt: document.defaultStylePrompt,
      },
    });

    this.broadcast(documentId, 'nodes-updated', result);

    logger.info({ documentId, ...result }, 'Node update completed successfully');
  }

  private async fetchAndValidateDocument(
    documentId: string,
    userId: string,
    errorEvent: string
  ) {
    const [document] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1);

    if (!document) {
      logger.error({ documentId, userId }, 'Document not found');
      return null;
    }

    const content = document.content.trim();

    if (!content) {
      this.broadcast(documentId, errorEvent, {
        error: 'Document is empty. Please add some text before analyzing.',
      });
      return null;
    }

    if (content.length < MIN_CONTENT_LENGTH) {
      this.broadcast(documentId, errorEvent, {
        error: `Document is too short. Please add at least ${MIN_CONTENT_LENGTH} characters of text.`,
      });
      return null;
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      this.broadcast(documentId, errorEvent, {
        error: `Document is too long. The maximum length for analysis is ${MAX_CONTENT_LENGTH} characters.`,
      });
      return null;
    }

    return document;
  }

  private broadcast(documentId: string, event: string, data: Record<string, any>) {
    sseService.broadcastToDocument(documentId, event, {
      documentId,
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  private async ack(messageId: string) {
    await this.streams.ack('text-analysis:stream', 'text-analysis-processors', messageId);
  }
}

export const textAnalysisConsumer = new TextAnalysisConsumer();

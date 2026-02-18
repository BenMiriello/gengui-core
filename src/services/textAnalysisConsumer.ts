/**
 * Text analysis stream consumer.
 * Orchestrates document analysis and node updates via Redis streams.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../config/database';
import { PubSubConsumer } from '../lib/pubsub-consumer';
import { documents } from '../models/schema';
import type { ExistingNode } from '../types/storyNodes';
import { logger } from '../utils/logger';
import { analyzeText, updateNodes } from './gemini';
import { mentionService } from './mentions';
import type { StreamMessage } from './redis-streams';
import { type Segment, segmentService } from './segments';
import { sseService } from './sse';
import { graphStoryNodesRepository } from './storyNodes';

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 50000;

class TextAnalysisConsumer extends PubSubConsumer {
  protected streamName = 'text-analysis:stream';
  protected groupName = 'text-analysis-processors';
  protected consumerName = `text-analysis-processor-${process.pid}`;

  constructor() {
    super('text-analysis-service');
  }

  protected async handleMessage(message: StreamMessage) {
    const { documentId, userId, reanalyze, updateMode } = message.data;

    if (!documentId || !userId) {
      logger.error({ data: message.data }, 'Request missing documentId or userId');
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
  }

  private async handleAnalyze(documentId: string, userId: string, reanalyze: boolean) {
    logger.info({ documentId, userId, reanalyze }, 'Processing text analysis request');

    const document = await this.fetchAndValidateDocument(documentId, userId, 'analysis-failed');
    if (!document) return;

    // Get segments (compute and persist if needed)
    const segments = await this.getDocumentSegments(documentId, document);

    // Call Gemini
    logger.info({ documentId, contentLength: document.content.length }, 'Calling Gemini API');
    const analysis = await analyzeText(document.content);

    // Delete existing if reanalyze
    if (reanalyze) {
      logger.info({ documentId }, 'Re-analyzing: deleting existing nodes and mentions');
      await graphStoryNodesRepository.deleteAllForDocument(documentId, userId);
      await mentionService.deleteByDocumentId(documentId);
    }

    // Create nodes, connections, and narrative threads (inherit document style)
    const nodeNameToId = await graphStoryNodesRepository.createNodes({
      userId,
      documentId,
      nodes: analysis.nodes,
      connections: analysis.connections,
      narrativeThreads: analysis.narrativeThreads,
      documentContent: document.content,
      segments,
      versionNumber: document.currentVersion,
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

    // Get segments (compute and persist if needed)
    const segments = await this.getDocumentSegments(documentId, document);

    // Fetch existing nodes
    const existingDbNodes = await graphStoryNodesRepository.getActiveNodes(documentId, userId);

    if (existingDbNodes.length === 0) {
      logger.info({ documentId }, 'No existing nodes to update');
      this.broadcast(documentId, 'update-failed', {
        error: 'No existing nodes to update. Use Analyze instead.',
      });
      return;
    }

    // Convert to format for Gemini, fetching passages from mentions
    const existingNodes: ExistingNode[] = await Promise.all(
      existingDbNodes.map(async (n) => {
        const mentions = await mentionService.getByNodeIdWithAbsolutePositions(n.id, segments);
        return {
          id: n.id,
          type: n.type,
          name: n.name,
          description: n.description || '',
          mentions: mentions.map((m) => ({ text: m.originalText })),
        };
      })
    );

    // Call Gemini
    logger.info(
      { documentId, existingNodeCount: existingNodes.length },
      'Calling Gemini updateNodes'
    );
    const updates = await updateNodes(document.content, existingNodes);

    // Apply updates (new nodes inherit document style)
    const result = await graphStoryNodesRepository.applyUpdates({
      userId,
      documentId,
      documentContent: document.content,
      segments,
      versionNumber: document.currentVersion,
      existingNodes: existingDbNodes.map((n) => ({ id: n.id, name: n.name })),
      updates,
      documentStyle: {
        preset: document.defaultStylePreset,
        prompt: document.defaultStylePrompt,
      },
    });

    this.broadcast(documentId, 'nodes-updated', result);

    logger.info({ documentId, ...result }, 'Node update completed successfully');
  }

  private async fetchAndValidateDocument(documentId: string, userId: string, errorEvent: string) {
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

  /**
   * Get segments from document, computing and persisting if needed.
   */
  private async getDocumentSegments(
    documentId: string,
    document: { content: string; segmentSequence: unknown }
  ): Promise<Segment[]> {
    const existing = parseSegmentSequence(document.segmentSequence);
    if (existing.length > 0) {
      return existing;
    }
    // Compute AND SAVE segments to database
    return segmentService.updateDocumentSegments(documentId);
  }
}

function parseSegmentSequence(raw: unknown): Segment[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (s): s is Segment =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.id === 'string' &&
        typeof s.start === 'number' &&
        typeof s.end === 'number'
    );
  }
  return [];
}

export const textAnalysisConsumer = new TextAnalysisConsumer();

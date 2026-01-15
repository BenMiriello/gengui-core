import { db } from '../config/database';
import { documents, storyNodes, storyNodeConnections } from '../models/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import { StreamMessage } from './redis-streams';
import { analyzeText, StoryNodeResult } from './geminiClient';
import { BlockingConsumer } from '../lib/blocking-consumer';

interface TextPosition {
  start: number;
  end: number;
  text: string;
}

class TextAnalysisService extends BlockingConsumer {
  constructor() {
    super('text-analysis-service');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('text-analysis:stream', 'text-analysis-processors');
  }

  protected async consumeLoop() {
    const consumerName = `text-analysis-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(
          'text-analysis:stream',
          'text-analysis-processors',
          consumerName,
          {
            block: 2000,
            count: 1,
          }
        );

        if (result) {
          try {
            await this.handleAnalysisRequest(
              'text-analysis:stream',
              'text-analysis-processors',
              result
            );
          } catch (error) {
            logger.error({ error, messageId: result.id }, 'Error processing analysis request');
            await this.streams.ack('text-analysis:stream', 'text-analysis-processors', result.id);
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error in text analysis consumer loop');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleAnalysisRequest(
    streamName: string,
    groupName: string,
    message: StreamMessage
  ) {
    const { documentId, userId, reanalyze } = message.data;

    if (!documentId || !userId) {
      logger.error({ data: message.data }, 'Analysis request missing documentId or userId');
      await this.streams.ack(streamName, groupName, message.id);
      return;
    }

    logger.info({ documentId, userId, reanalyze }, 'Processing text analysis request');

    try {
      // Fetch document
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
        .limit(1);

      if (!document) {
        logger.error({ documentId, userId }, 'Document not found');
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      // Validate document content
      const trimmedContent = document.content.trim();
      if (!trimmedContent) {
        logger.error({ documentId }, 'Document is empty');
        sseService.broadcastToDocument(documentId, 'analysis-failed', {
          documentId,
          error: 'Document is empty. Please add some text before analyzing.',
          timestamp: new Date().toISOString(),
        });
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      if (trimmedContent.length < 50) {
        logger.error({ documentId, length: trimmedContent.length }, 'Document too short');
        sseService.broadcastToDocument(documentId, 'analysis-failed', {
          documentId,
          error: 'Document is too short. Please add at least 50 characters of text.',
          timestamp: new Date().toISOString(),
        });
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      if (trimmedContent.length > 50000) {
        logger.error({ documentId, length: trimmedContent.length }, 'Document too long');
        sseService.broadcastToDocument(documentId, 'analysis-failed', {
          documentId,
          error: 'Document is too long. The maximum length for analysis is 50,000 characters.',
          timestamp: new Date().toISOString(),
        });
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      // Call Gemini API
      logger.info({ documentId, contentLength: document.content.length }, 'Calling Gemini API');
      const analysis = await analyzeText(document.content);

      // If reanalyze, delete existing nodes (connections will cascade)
      if (reanalyze === 'true') {
        logger.info({ documentId }, 'Re-analyzing: deleting existing nodes');
        await db
          .delete(storyNodes)
          .where(and(eq(storyNodes.documentId, documentId), eq(storyNodes.userId, userId)));
      }

      // Process and store nodes
      const createdNodes: Array<{ id: string; name: string }> = [];

      for (const nodeData of analysis.nodes) {
        // Try to find text positions for passages (logs warnings if not found)
        // Temporarily store all passages even if they don't match, for demo purposes
        const passages = nodeData.passages.map(p => {
          const index = document.content.indexOf(p.text);
          if (index !== -1) {
            return {
              start: index,
              end: index + p.text.length,
              text: p.text,
            };
          } else {
            logger.warn({ passageText: p.text }, 'Passage text not found in document');
            return { text: p.text };
          }
        });

        const [node] = await db
          .insert(storyNodes)
          .values({
            userId,
            documentId,
            type: nodeData.type,
            name: nodeData.name,
            description: nodeData.description,
            passages: JSON.stringify(passages),
            metadata: nodeData.metadata ? JSON.stringify(nodeData.metadata) : null,
          })
          .returning({ id: storyNodes.id, name: storyNodes.name });

        createdNodes.push(node);
        logger.info({ nodeId: node.id, nodeName: node.name, type: nodeData.type }, 'Story node created');
      }

      // Create connections
      for (const connData of analysis.connections) {
        const fromNode = createdNodes.find(n => n.name === connData.fromName);
        const toNode = createdNodes.find(n => n.name === connData.toName);

        if (fromNode && toNode) {
          await db.insert(storyNodeConnections).values({
            fromNodeId: fromNode.id,
            toNodeId: toNode.id,
            description: connData.description,
          });

          logger.info(
            { from: connData.fromName, to: connData.toName },
            'Story node connection created'
          );
        } else {
          logger.warn(
            { from: connData.fromName, to: connData.toName },
            'Connection references unknown node(s)'
          );
        }
      }

      // Broadcast SSE to document viewers
      sseService.broadcastToDocument(documentId, 'analysis-complete', {
        documentId,
        nodesCount: createdNodes.length,
        connectionsCount: analysis.connections.length,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        { documentId, nodesCount: createdNodes.length, connectionsCount: analysis.connections.length },
        'Text analysis completed successfully'
      );

      await this.streams.ack(streamName, groupName, message.id);
    } catch (error: any) {
      const errorMessage = error?.message || 'Analysis failed. Please try again.';
      logger.error({ error, documentId, errorMessage }, 'Text analysis failed');

      // Broadcast error to user with specific error message
      sseService.broadcastToDocument(documentId, 'analysis-failed', {
        documentId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      await this.streams.ack(streamName, groupName, message.id);
    }
  }

  private findTextPositions(content: string, passages: string[]): TextPosition[] {
    const positions: TextPosition[] = [];

    for (const passageText of passages) {
      const index = content.indexOf(passageText);

      if (index !== -1) {
        positions.push({
          start: index,
          end: index + passageText.length,
          text: passageText,
        });
      } else {
        logger.warn({ passageText }, 'Passage text not found in document');
      }
    }

    return positions;
  }
}

export const textAnalysisService = new TextAnalysisService();

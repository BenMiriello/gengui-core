/**
 * Redis Streams consumer for durable analysis completion events.
 *
 * Replaces fire-and-forget pub/sub persistence for mentions, document summary,
 * LLM usage, and chat responses. XACK only after all persistence succeeds,
 * giving at-least-once delivery semantics.
 *
 * Stream key:     analysis:completion
 * Consumer group: core-persistence
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database';
import { calculateLLMCost } from '../config/pricing';
import {
  analysisChatMessages,
  analysisChats,
  documents,
} from '../models/schema';
import { logger } from '../utils/logger';
import { persistMentionsFromEntities } from './analysisReconciliation';
import { redis } from './redis';
import { usageTrackingService } from './usageTracking/usageTrackingService';

const STREAM_KEY = 'analysis:completion';
const CONSUMER_GROUP = 'core-persistence';
const CONSUMER_NAME = 'worker-1';
const BLOCK_TIMEOUT_MS = 5000;

interface EntityMention {
  segment_id: string;
  text: string;
  start: number | null;
  end: number | null;
}

interface AnalysisEntity {
  id: string;
  mentions?: EntityMention[];
}

interface LLMUsageRecord {
  operation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

interface AnalysisCompletionEvent {
  runId: string;
  documentId: string;
  status: 'complete' | 'failed' | 'cancelled';
  completedAt: string;
  entities?: AnalysisEntity[];
  documentSummary?: string | null;
  chatResponse?: string | null;
  llmUsage?: LLMUsageRecord[];
}

export function startCompletionStreamConsumer(): () => void {
  const client = redis.getClient();
  let running = true;

  async function ensureConsumerGroup(): Promise<void> {
    try {
      await client.xgroup(
        'CREATE',
        STREAM_KEY,
        CONSUMER_GROUP,
        '$',
        'MKSTREAM',
      );
    } catch (e: unknown) {
      // BUSYGROUP means the group already exists — expected on restarts
      if (!(e instanceof Error) || !e.message.includes('BUSYGROUP')) {
        throw e;
      }
    }
  }

  async function drainPending(): Promise<void> {
    // Process any messages that were delivered but not ACKed in a previous run
    while (running) {
      const results = (await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        CONSUMER_NAME,
        'COUNT',
        '10',
        'STREAMS',
        STREAM_KEY,
        '0-0',
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results || results[0][1].length === 0) break;

      for (const [, messages] of results) {
        for (const [messageId, fields] of messages) {
          await processMessage(client, messageId, fields);
        }
      }
    }
  }

  async function loop(): Promise<void> {
    try {
      await ensureConsumerGroup();
    } catch (e) {
      logger.error({ e }, 'Failed to create completion stream consumer group');
      return;
    }

    await drainPending();

    while (running) {
      try {
        const results = (await client.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          CONSUMER_NAME,
          'COUNT',
          '1',
          'BLOCK',
          String(BLOCK_TIMEOUT_MS),
          'STREAMS',
          STREAM_KEY,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [messageId, fields] of messages) {
            await processMessage(client, messageId, fields);
          }
        }
      } catch (e) {
        if (running) {
          logger.error({ e }, 'Completion stream consumer error');
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  loop().catch((e) => logger.error({ e }, 'Completion stream loop crashed'));

  return () => {
    running = false;
  };
}

async function processMessage(
  client: ReturnType<typeof redis.getClient>,
  messageId: string,
  fields: string[],
): Promise<void> {
  const fieldMap: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    fieldMap[fields[i]] = fields[i + 1];
  }

  const rawData = fieldMap.data;
  if (!rawData) {
    logger.warn(
      { messageId },
      'Completion stream message missing data field; skipping',
    );
    await client.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    return;
  }

  let event: AnalysisCompletionEvent;
  try {
    event = JSON.parse(rawData) as AnalysisCompletionEvent;
  } catch (e) {
    logger.error({ e, messageId }, 'Malformed completion event; skipping');
    await client.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    return;
  }

  if (event.status !== 'complete') {
    await client.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    return;
  }

  try {
    await persistCompletionData(event);
    await client.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    logger.info(
      { runId: event.runId, documentId: event.documentId },
      'Completion event persisted and acknowledged',
    );
  } catch (e) {
    // Don't XACK — the message will be redelivered on next startup
    logger.error(
      { e, runId: event.runId, documentId: event.documentId },
      'Failed to persist completion data; message will be redelivered',
    );
  }
}

async function persistCompletionData(
  event: AnalysisCompletionEvent,
): Promise<void> {
  const { documentId, runId } = event;

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) {
    logger.warn(
      { documentId },
      'Document not found for completion event; skipping',
    );
    return;
  }

  const segments =
    (doc.segmentSequence as Array<{
      id: string;
      start: number;
      end: number;
    }>) ?? [];

  // Mentions — delete existing for this document then reinsert from the stream payload
  if (event.entities?.length) {
    const result = await persistMentionsFromEntities({
      documentId,
      entities: event.entities,
      documentContent: doc.content,
      currentVersion: doc.currentVersion,
      segments,
    });
    if (result.count > 0) {
      logger.info(
        {
          documentId,
          mentionCount: result.count,
          recoveredOffsets: result.recovered,
        },
        'Persisted mentions from completion stream',
      );
    }
    // Invalidate layout so projection recomputes with new embeddings
    await db
      .update(documents)
      .set({ layoutPositions: null })
      .where(eq(documents.id, documentId));
  }

  // Document summary
  if (event.documentSummary) {
    await db
      .update(documents)
      .set({ summary: event.documentSummary })
      .where(eq(documents.id, documentId));
  }

  // LLM usage
  if (event.llmUsage?.length) {
    for (const record of event.llmUsage) {
      let costUsd = 0;
      try {
        ({ apiCostUsd: costUsd } = calculateLLMCost({
          model: record.model,
          inputTokens: record.input_tokens,
          outputTokens: record.output_tokens,
        }));
      } catch {
        logger.warn(
          { model: record.model },
          'Unknown model for cost calculation, using zero',
        );
      }
      await usageTrackingService.recordLLMUsage({
        userId: doc.userId,
        documentId,
        requestId: runId,
        operation: `analysis:${record.operation}`,
        model: record.model,
        inputTokens: record.input_tokens,
        outputTokens: record.output_tokens,
        costUsd,
        durationMs: Math.round(record.latency_ms),
      });
    }
  }

  // Chat response
  if (event.chatResponse) {
    const chat = await db.query.analysisChats.findFirst({
      where: eq(analysisChats.documentId, documentId),
      orderBy: [desc(analysisChats.updatedAt)],
    });
    if (chat) {
      await db.insert(analysisChatMessages).values({
        chatId: chat.id,
        role: 'assistant',
        content: event.chatResponse,
        metadata: { source: 'pipeline' },
      });
      await db
        .update(analysisChats)
        .set({ updatedAt: new Date() })
        .where(eq(analysisChats.id, chat.id));
    }
  }

  // Advance reconciliation watermark only after all persistence succeeds
  await db
    .update(documents)
    .set({ lastCompletionSeenAt: new Date(event.completedAt) })
    .where(eq(documents.id, documentId));
}

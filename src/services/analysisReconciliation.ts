/**
 * Analysis reconciliation — shared logic for persisting analysis outputs into
 * core's local tables. Used by both the Redis Streams consumer (event-driven)
 * and the document-open drift check (pull-based recovery when events were
 * missed during downtime).
 */

import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { documents } from '../models/schema';
import { logger } from '../utils/logger';
import { analysisClient } from './analysisClient';
import {
  type CreateMentionInput,
  fuzzyFindTextInSegment,
  mentionService,
} from './mentions';

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

interface Segment {
  id: string;
  start: number;
  end: number;
}

interface PersistMentionsParams {
  documentId: string;
  entities: AnalysisEntity[];
  documentContent: string;
  currentVersion: number;
  segments: Segment[];
}

/**
 * Replace all mentions for a document with the supplied entity payload.
 * Uses delete-then-reinsert so the operation is idempotent on redelivery
 * and on reconciliation runs. Recovers missing offsets via exact-match,
 * then fuzzy match against the current document content.
 */
export async function persistMentionsFromEntities(
  params: PersistMentionsParams,
): Promise<{ count: number; recovered: number }> {
  const { documentId, entities, documentContent, currentVersion, segments } =
    params;

  await mentionService.deleteByDocumentId(documentId);
  const inputs: CreateMentionInput[] = [];
  let recovered = 0;

  for (const entity of entities) {
    if (!entity.mentions?.length) continue;
    for (const m of entity.mentions) {
      if (!m.segment_id || !m.text) continue;

      let relativeStart = m.start;
      let relativeEnd = m.end;

      if (relativeStart == null || relativeEnd == null) {
        const segment = segments.find((s) => s.id === m.segment_id);
        if (!segment || !documentContent) continue;
        const segmentText = documentContent.slice(segment.start, segment.end);

        const exactIdx = segmentText.indexOf(m.text);
        if (exactIdx !== -1) {
          relativeStart = exactIdx;
          relativeEnd = exactIdx + m.text.length;
          recovered++;
        } else {
          const fuzzyResult = fuzzyFindTextInSegment(
            documentContent,
            {
              sourceText: m.text,
              originalStart: segment.start,
              originalEnd: segment.end,
            },
            segments,
            m.segment_id,
          );
          if (fuzzyResult && fuzzyResult.confidence >= 0.7) {
            relativeStart = fuzzyResult.start - segment.start;
            relativeEnd = fuzzyResult.end - segment.start;
            recovered++;
          } else {
            logger.debug(
              {
                entityId: entity.id,
                mentionText: m.text,
                segmentId: m.segment_id,
              },
              'Could not recover mention offset',
            );
            continue;
          }
        }
      }

      inputs.push({
        nodeId: entity.id,
        documentId,
        segmentId: m.segment_id,
        relativeStart,
        relativeEnd,
        originalText: m.text,
        versionNumber: currentVersion,
        source: 'extraction',
      });
    }
  }

  if (inputs.length > 0) {
    await mentionService.createBatch(inputs);
  }

  return { count: inputs.length, recovered };
}

/**
 * Drift check + reconciliation entry point invoked on document open.
 * Fire-and-forget safe: fails silently if analysis service unavailable so
 * editor availability never depends on analysis availability.
 */
export async function reconcileDocumentOnLoad(
  documentId: string,
): Promise<void> {
  let status: Awaited<ReturnType<typeof analysisClient.getAnalysisStatus>>;
  try {
    status = await analysisClient.getAnalysisStatus(documentId);
  } catch (e) {
    logger.debug(
      { e, documentId },
      'Analysis status unreachable; skipping reconciliation',
    );
    return;
  }

  const remoteFinish = status.last_pipeline_finish_at
    ? new Date(status.last_pipeline_finish_at)
    : null;
  if (!remoteFinish) return;

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) return;

  const localWatermark = doc.lastCompletionSeenAt;
  if (localWatermark && localWatermark >= remoteFinish) return;

  logger.info(
    {
      documentId,
      remoteFinish: remoteFinish.toISOString(),
      localWatermark: localWatermark?.toISOString() ?? null,
    },
    'Reconciling document with analysis service',
  );

  try {
    const { entities } = await analysisClient.getEntities(documentId);
    const segments =
      (doc.segmentSequence as Array<{
        id: string;
        start: number;
        end: number;
      }>) ?? [];

    const mappedEntities: AnalysisEntity[] = entities.map((e) => ({
      id: e.id,
      mentions: e.mentions?.map((m) => ({
        segment_id: m.segment_id ?? '',
        text: m.text,
        start: m.start ?? null,
        end: m.end ?? null,
      })),
    }));

    const result = await persistMentionsFromEntities({
      documentId,
      entities: mappedEntities,
      documentContent: doc.content,
      currentVersion: doc.currentVersion,
      segments,
    });

    const updates: Record<string, unknown> = {
      lastCompletionSeenAt: remoteFinish,
    };
    if (status.document_summary) {
      updates.summary = status.document_summary;
    }
    if (result.count > 0) {
      updates.layoutPositions = null;
    }

    await db.update(documents).set(updates).where(eq(documents.id, documentId));

    logger.info(
      {
        documentId,
        mentionCount: result.count,
        recoveredOffsets: result.recovered,
        summaryUpdated: !!status.document_summary,
      },
      'Reconciliation complete',
    );
  } catch (e) {
    logger.warn(
      { e, documentId },
      'Reconciliation failed mid-flight; watermark not advanced',
    );
  }
}

import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { documents } from '../models/schema';
import { analysisClient } from '../services/analysisClient';
import type { CreateMentionInput } from '../services/mentions';
import { mentionService } from '../services/mentions';
import { redis } from '../services/redis';
import { segmentService } from '../services/segments';
import { sseService } from '../services/sse';
import { logger } from '../utils/logger';
import { parseStringParam } from '../utils/validation';

const router = Router();

// --- Part 2: Analysis trigger ---

router.post(
  '/analysis/documents/:id/analyze',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const userId = req.user?.id;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== userId) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      if (doc.analysisStatus === 'analyzing') {
        res
          .status(409)
          .json({ error: 'Analysis already in progress (old pipeline)' });
        return;
      }

      const lockKey = `analysis:lock:${documentId}`;
      const existingLock = await redis.get(lockKey);
      if (existingLock) {
        res
          .status(409)
          .json({ error: 'Analysis already in progress for this document' });
        return;
      }

      let segments = await segmentService.getDocumentSegments(documentId);

      if (segments.length === 0 && doc.content?.length > 0) {
        const computedSegments = segmentService.computeSegments(doc.content);
        await db
          .update(documents)
          .set({ segmentSequence: computedSegments })
          .where(eq(documents.id, documentId));
        segments = computedSegments;
      }

      if (segments.length === 0) {
        res.status(400).json({ error: 'Document has no content to analyze' });
        return;
      }

      const domain = req.body.domain || null;

      const { run_id } = await analysisClient.startAnalysis({
        document_id: documentId,
        user_id: userId,
        document_content: doc.content,
        segments: segments.map((s, i) => ({
          id: s.id,
          text: doc.content.slice(s.start, s.end),
          order: i,
        })),
        domain,
      });

      await redis.set(lockKey, run_id, 600);

      subscribeToAnalysisProgress(run_id, documentId);

      res.json({ runId: run_id });
    } catch (error) {
      next(error);
    }
  },
);

// --- Part 4: Analysis settings ---

router.get(
  '/analysis/documents/:id/settings',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user?.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      res.json(doc.analysisSettings || {});
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  '/analysis/documents/:id/settings',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user?.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const { domain, enabledLayers, automationLevel } = req.body;
      await db
        .update(documents)
        .set({ analysisSettings: { domain, enabledLayers, automationLevel } })
        .where(eq(documents.id, documentId));
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// --- Part 3: Graph read proxies ---

router.get(
  '/analysis/graph/:documentId/entities',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.documentId, 'documentId');
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user?.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const result = await analysisClient.getEntities(documentId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/analysis/graph/:documentId/connections',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.documentId, 'documentId');
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user?.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const result = await analysisClient.getConnections(documentId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/analysis/graph/entities/:entityId',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const entityId = parseStringParam(req.params.entityId, 'entityId');
      const entity = await analysisClient.getEntity(entityId);
      if (!entity) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }
      res.json(entity);
    } catch (error) {
      next(error);
    }
  },
);

// --- Part 2 continued: Redis subscriber ---

function subscribeToAnalysisProgress(runId: string, documentId: string): void {
  const channel = `analysis:progress:${runId}`;
  const lockKey = `analysis:lock:${documentId}`;

  redis
    .subscribeChannel(channel, (message) => {
      try {
        const data = JSON.parse(message);
        const ssePayload = { runId, ...data };

        sseService.broadcastToDocument(
          documentId,
          'analysis-progress',
          ssePayload,
        );

        if (data.stage === 'pipeline') {
          redis.unsubscribeChannel(channel);
          redis.del(lockKey);
          logger.debug(
            { runId },
            'Analysis progress subscription ended, lock released',
          );

          if (data.status === 'complete') {
            persistMentionsAfterAnalysis(documentId).catch((e) => {
              logger.error(
                { e, documentId },
                'Failed to persist mentions after analysis',
              );
            });
          }
        }
      } catch (e) {
        logger.error(
          { e, message },
          'Failed to parse analysis progress message',
        );
      }
    })
    .catch((err) => {
      logger.error({ err, runId }, 'Failed to subscribe to analysis progress');
    });
}

async function persistMentionsAfterAnalysis(documentId: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) return;

  const { entities } = await analysisClient.getEntities(documentId);

  const inputs: CreateMentionInput[] = [];
  for (const entity of entities) {
    if (!entity.mentions?.length) continue;
    for (const m of entity.mentions) {
      if (!m.segment_id || m.start == null || m.end == null) continue;
      inputs.push({
        nodeId: entity.id,
        documentId,
        segmentId: m.segment_id,
        relativeStart: m.start,
        relativeEnd: m.end,
        originalText: m.text,
        versionNumber: doc.currentVersion,
        source: 'extraction',
      });
    }
  }

  if (inputs.length > 0) {
    await mentionService.createBatch(inputs);
    logger.info(
      { documentId, mentionCount: inputs.length },
      'Persisted mentions after analysis',
    );
  }
}

export { router as analysisRouter };

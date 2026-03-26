import { and, eq, isNull } from 'drizzle-orm';
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import {
  getCurrentAnalysisVersion,
  getVersionDiff,
} from '../config/analysis-versions';
import { db } from '../config/database';
import { jobService } from '../jobs/service';
import { requireAuth } from '../middleware/auth';
import { analysisSnapshots, documents, jobs, mentions } from '../models/schema';
import { documentsService } from '../services/documents';
import {
  computeCausalOrder,
  detectThreads,
  findCausalGaps,
  findPivotalNodes,
} from '../services/graph/graph.analysis';
import { graphService } from '../services/graph/graph.service';
import { graphThreads } from '../services/graph/graph.threads';
import { mediaService } from '../services/mediaService';
import { mentionService } from '../services/mentions/mention.service';
import { clearCheckpoint } from '../services/pipeline/checkpoint';
import { redis } from '../services/redis';
import { redisStreams } from '../services/redis-streams';
import { sseService } from '../services/sse';
import { stalenessService } from '../services/staleness';
import { graphStoryNodesRepository } from '../services/storyNodes';
import { UsageQuotaExceededError, usageService } from '../services/usage';
import { versioningService } from '../services/versioning';
import { sanitizeError } from '../utils/error-sanitizer';
import { BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';
import { parseStringParam } from '../utils/validation';

const router = Router();

router.get(
  '/documents',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const documents = await documentsService.list(userId);
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  },
);

// IMPORTANT: /documents/trash must come BEFORE /documents/:id
// Otherwise Express matches "trash" as an :id parameter
router.get(
  '/documents/trash',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const documents = await documentsService.listDeleted(userId);
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const document = await documentsService.get(id, userId);
      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { title, content } = req.body;

      if (content === undefined) {
        res.status(400).json({
          error: { message: 'Content is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const document = await documentsService.create(
        userId,
        title,
        content || '',
      );

      await sseService.broadcastToUser(userId, 'document-updated', {
        documentId: document.id,
        currentVersion: 1,
        updatedAt: document.createdAt,
      });

      res.status(201).json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/copy',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { title } = req.body;
      const document = await documentsService.copy(
        id,
        userId,
        title || 'Untitled',
      );

      await sseService.broadcastToUser(userId, 'document-updated', {
        documentId: document.id,
        currentVersion: 1,
        updatedAt: document.createdAt,
      });

      res.status(201).json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const {
        content,
        yjsState,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
        narrativeModeEnabled,
        mediaModeEnabled,
        expectedVersion,
        forceOverwrite,
      } = req.body;

      const document = await documentsService.update(id, userId, {
        content,
        yjsState,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
        narrativeModeEnabled,
        mediaModeEnabled,
        expectedVersion,
        forceOverwrite,
      });

      await sseService.broadcastToDocument(id, 'document-updated', {
        documentId: document.id,
        currentVersion: document.currentVersion,
        updatedAt: document.updatedAt,
      });

      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/versions',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const limit = parseInt(req.query.limit as string, 10) || 50;

      await documentsService.get(id, userId);
      const versions = await versioningService.getVersions(id, limit);
      res.json({ versions });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/versions/:versionNumber',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const versionNumber = parseStringParam(
        req.params.versionNumber,
        'versionNumber',
      );

      await documentsService.get(id, userId);
      const version = await versioningService.getVersion(
        id,
        parseInt(versionNumber, 10),
      );

      if (!version) {
        res
          .status(404)
          .json({ error: { message: 'Version not found', code: 'NOT_FOUND' } });
        return;
      }

      res.json({ version });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/documents/:id/modes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { narrativeModeEnabled, mediaModeEnabled } = req.body;

      const document = await documentsService.update(id, userId, {
        narrativeModeEnabled,
        mediaModeEnabled,
      });
      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await sseService.broadcastToDocument(id, 'document-deleted', {
        documentId: id,
      });

      await documentsService.delete(id, userId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/restore',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const document = await documentsService.restore(id, userId);
      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/info',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const info = await documentsService.getDeletedInfo(id, userId);
      res.json(info);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id/permanent',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { deleteMedia } = req.body || {};
      await documentsService.permanentDelete(id, userId, { deleteMedia });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/media/deleted',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const media = await mediaService.getDeletedDocumentMedia(id, userId);
      res.json({ media });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/media',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const media = await mediaService.getDocumentMedia(id);
      res.json({ media });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id/media',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const count = await mediaService.softDeleteDocumentMedia(id, userId);
      res.json({ message: 'Media soft deleted', count });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/media/restore',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const count = await mediaService.restoreDocumentMedia(id, userId);
      res.json({ message: 'Media restored', count });
    } catch (error) {
      next(error);
    }
  },
);

// SSE endpoints removed - use unified /sse/events endpoint with channel subscriptions

router.get(
  '/documents/:id/analysis-status',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      const document = await documentsService.get(id, userId);
      const nodes = await graphStoryNodesRepository.getActiveNodes(id, userId);

      const hasAnalysis = nodes.length > 0;
      const lastAnalyzedVersion = document.lastAnalyzedVersion ?? null;
      const currentVersion = document.currentVersion;
      const hasChanges =
        lastAnalyzedVersion !== null && lastAnalyzedVersion < currentVersion;

      // Query jobs table for active analysis job
      const activeJob = await jobService.getActiveForTarget(
        'document_analysis',
        id,
      );

      let analysisStatus: string | null = null;
      let analysisStartedAt: Date | null = null;
      let currentStage: number | null = null;
      let jobId: string | null = null;
      let errorMessage: string | null = null;

      if (activeJob) {
        jobId = activeJob.id;
        analysisStartedAt = activeJob.startedAt;

        // Map job status to analysis status
        switch (activeJob.status) {
          case 'queued':
            analysisStatus = 'queued';
            break;
          case 'processing': {
            analysisStatus = 'analyzing';
            // Check for stale (progress stall detection)
            const STALE_STARTED_MS = 10 * 60 * 1000;
            const STALE_PROGRESS_MS = 5 * 60 * 1000;
            if (activeJob.startedAt) {
              const startedElapsed =
                Date.now() - new Date(activeJob.startedAt).getTime();
              const progressElapsed = activeJob.progressUpdatedAt
                ? Date.now() - new Date(activeJob.progressUpdatedAt).getTime()
                : startedElapsed;

              if (
                startedElapsed > STALE_STARTED_MS &&
                progressElapsed > STALE_PROGRESS_MS
              ) {
                analysisStatus = 'stale';
              }
            }
            break;
          }
          case 'paused':
            analysisStatus = 'paused';
            break;
          case 'failed':
            analysisStatus = 'failed';
            break;
        }

        // Get current stage from progress
        const progress = activeJob.progress as { stage?: number } | null;
        if (progress?.stage) {
          currentStage = progress.stage;
        }
      } else {
        // No active job - check for recent failed job
        const recentFailed = await jobService.getRecentFailedForTarget(
          'document_analysis',
          id,
          1, // 1 hour TTL for showing failed state
        );

        if (recentFailed) {
          analysisStatus = 'failed';
          errorMessage = recentFailed.errorMessage
            ? sanitizeError(recentFailed.errorMessage)
            : null;
          jobId = recentFailed.id;
        }
      }

      res.json({
        hasAnalysis,
        lastAnalyzedVersion,
        currentVersion,
        hasChanges,
        nodeCount: nodes.length,
        analysisStatus,
        analysisStartedAt,
        currentStage,
        jobId,
        errorMessage,
        analysisVersion: document.analysisVersion ?? null,
        latestAnalysisVersion: getCurrentAnalysisVersion(),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/staleness',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      const document = await documentsService.get(id, userId);
      const result = await stalenessService.detectStaleness(
        id,
        document.content,
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/analyze',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const reanalyze = req.query.reanalyze === 'true';

      const document = await documentsService.get(id, userId);

      // Pre-flight validation
      const content = document.content?.trim() ?? '';

      if (!content) {
        throw new BadRequestError(
          'Document is empty. Please add some text before analyzing.',
        );
      }

      if (content.length < 50) {
        throw new BadRequestError(
          'Document is too short. Please add at least 50 characters of text.',
        );
      }

      // Check quota before creating job
      const wordCount = document.content
        ? document.content.split(/\s+/).filter((word) => word.length > 0).length
        : 0;
      const tokenUnits = Math.ceil(wordCount / 600);

      const { operationId } = await usageService.checkAndReserveQuota({
        userId,
        operationType: 'llm-query-1k-tokens',
        units: tokenUnits,
      });

      // Create job (fails if one already exists due to unique constraint)
      const job = await jobService.create({
        type: 'document_analysis',
        targetType: 'document',
        targetId: id,
        userId,
        payload: {
          reanalyze,
          operationId: operationId || undefined,
        },
      });

      if (!job) {
        // Job already exists for this document - release quota reservation
        if (operationId) {
          await usageService.finalizeReservation({
            operationId,
            userId,
            success: false,
          });
        }

        res.status(409).json({
          error: {
            code: 'ANALYSIS_IN_PROGRESS',
            message: 'Analysis is already in progress for this document',
          },
        });
        return;
      }

      res.status(202).json({
        jobId: job.id,
        status: job.status,
        message: 'Analysis queued',
      });
    } catch (error) {
      if (error instanceof UsageQuotaExceededError) {
        res.status(403).json({
          error: 'QUOTA_EXCEEDED',
          message: `You've used all your monthly usage. Resets on ${error.resetDate.toLocaleDateString()}.`,
          resetDate: error.resetDate,
        });
        return;
      }
      next(error);
    }
  },
);

router.post(
  '/documents/:id/analysis/pause',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      // Find active job
      const activeJob = await jobService.getActiveForTarget(
        'document_analysis',
        id,
      );

      if (!activeJob || activeJob.status !== 'processing') {
        res.status(400).json({
          error: {
            message: 'No active analysis to pause',
            code: 'INVALID_STATE',
          },
        });
        return;
      }

      // Update job status to paused - worker will see it at next checkInterruption()
      await db
        .update(jobs)
        .set({ status: 'paused' })
        .where(eq(jobs.id, activeJob.id));

      // Also update document status for backwards compatibility with pipeline
      await db
        .update(documents)
        .set({ analysisStatus: 'paused' })
        .where(eq(documents.id, id));

      // Broadcast immediately so frontend gets feedback
      sseService.broadcastToDocument(id, 'job-status-changed', {
        jobId: activeJob.id,
        jobType: 'document_analysis',
        status: 'paused',
        documentId: id,
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, jobId: activeJob.id });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/analysis/cancel',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      // Find active job
      const activeJob = await jobService.getActiveForTarget(
        'document_analysis',
        id,
      );

      if (!activeJob) {
        res.status(400).json({
          error: {
            message: 'No active analysis to cancel',
            code: 'INVALID_STATE',
          },
        });
        return;
      }

      // Update job status to cancelled
      await db
        .update(jobs)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          checkpoint: null,
        })
        .where(eq(jobs.id, activeJob.id));

      // Also update document status for backwards compatibility
      await db
        .update(documents)
        .set({ analysisStatus: 'cancelled' })
        .where(eq(documents.id, id));

      // Clean up immediately (whether paused or processing)
      await clearCheckpoint(id);
      await graphService.deleteAllStoryNodesForDocument(id, userId);
      await mentionService.deleteByDocumentId(id);

      sseService.broadcastToDocument(id, 'job-cancelled', {
        jobId: activeJob.id,
        jobType: 'document_analysis',
        documentId: id,
        timestamp: new Date().toISOString(),
      });

      sseService.clearDocumentBuffer(id);

      res.json({ success: true, jobId: activeJob.id });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/analysis/resume',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      // Find paused job
      const activeJob = await jobService.getActiveForTarget(
        'document_analysis',
        id,
      );

      if (!activeJob || activeJob.status !== 'paused') {
        res.status(400).json({
          error: {
            message: 'No paused analysis to resume',
            code: 'INVALID_STATE',
          },
        });
        return;
      }

      // Set job back to queued - worker will pick it up
      await db
        .update(jobs)
        .set({ status: 'queued' })
        .where(eq(jobs.id, activeJob.id));

      // Also update document status for backwards compatibility
      await db
        .update(documents)
        .set({ analysisStatus: 'analyzing' })
        .where(eq(documents.id, id));

      // Notify worker
      await redis.publish('jobs:notify:document_analysis', activeJob.id);

      sseService.broadcastToDocument(id, 'job-status-changed', {
        jobId: activeJob.id,
        jobType: 'document_analysis',
        status: 'queued',
        documentId: id,
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, jobId: activeJob.id });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/story-nodes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      // Fetch active story nodes from FalkorDB
      const nodes = await graphStoryNodesRepository.getActiveNodes(id, userId);

      // Fetch active connections from FalkorDB
      const connections =
        nodes.length > 0
          ? await graphStoryNodesRepository.getConnectionsForDocument(id)
          : [];

      res.json({ nodes, connections });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/documents/:id/story-nodes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      // Verify user owns document
      await documentsService.get(id, userId);

      await redisStreams.add('text-analysis:stream', {
        documentId: id,
        userId,
        updateMode: 'true',
      });

      res.status(202).json({ message: 'Update queued' });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id/story-nodes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      logger.info({ documentId: id, userId }, 'DELETE story-nodes called');

      // Get node IDs before deletion for SSE event
      const nodes = await graphStoryNodesRepository.getActiveNodes(id, userId);
      const nodeIds = nodes.map((n) => n.id);

      // Check state BEFORE delete
      const [docBefore] = await db
        .select({
          analysisStatus: documents.analysisStatus,
          hasCheckpoint: documents.analysisCheckpoint,
        })
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1);

      logger.info(
        {
          documentId: id,
          statusBefore: docBefore?.analysisStatus,
          hasCheckpointBefore: !!docBefore?.hasCheckpoint,
        },
        'State before delete',
      );

      // Phase 1: Delete FalkorDB data (OUTSIDE transaction - separate database)
      logger.info({ documentId: id }, 'Starting FalkorDB delete');
      await graphStoryNodesRepository.deleteAllForDocument(id, userId);
      logger.info({ documentId: id }, 'FalkorDB delete completed');

      // Phase 2: Update PostgreSQL atomically
      await db.transaction(async (tx) => {
        // Delete mentions from Postgres
        const mentionResult = await tx
          .delete(mentions)
          .where(eq(mentions.documentId, id));
        logger.info(
          { documentId: id, mentionsDeleted: mentionResult },
          'Mentions deleted',
        );

        // Delete analysis snapshots
        const snapshotResult = await tx
          .delete(analysisSnapshots)
          .where(eq(analysisSnapshots.documentId, id));
        logger.info(
          { documentId: id, snapshotsDeleted: snapshotResult },
          'Analysis snapshots deleted',
        );

        // Clear ALL analysis data including summaries
        const updateResult = await tx
          .update(documents)
          .set({
            analysisStatus: 'idle',
            analysisStartedAt: null,
            analysisCompletedAt: null,
            analysisCheckpoint: null,
            segmentSequence: [],
            summary: null,
            summaryEditChainLength: 0,
            summaryUpdatedAt: null,
          })
          .where(eq(documents.id, id));

        logger.info(
          { documentId: id, rowsUpdated: updateResult },
          'Document analysis data cleared',
        );
      });

      // Verify state AFTER delete
      const [docAfter] = await db
        .select({
          analysisStatus: documents.analysisStatus,
          hasCheckpoint: documents.analysisCheckpoint,
        })
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1);

      logger.info(
        {
          documentId: id,
          statusAfter: docAfter?.analysisStatus,
          hasCheckpointAfter: !!docAfter?.hasCheckpoint,
        },
        'State after delete - DELETE COMPLETED',
      );

      await sseService.broadcastToDocument(id, 'node-deleted', {
        documentId: id,
        nodeIds,
      });

      res.json({ success: true });
    } catch (error) {
      logger.error(
        { error, documentId: req.params.id },
        'DELETE story-nodes FAILED',
      );
      next(error);
    }
  },
);

router.get(
  '/documents/:id/node-similarities',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const k = parseInt(req.query.k as string, 10) || 10;
      const cutoff = parseFloat(req.query.cutoff as string) || 0.3;

      await documentsService.get(id, userId);

      const similarities = await graphService.getNodeSimilaritiesForDocument(
        id,
        userId,
        k,
        cutoff,
      );

      res.json({ similarities });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/graph-analysis',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      const [causalOrder, threads, pivotalNodes, causalGaps] =
        await Promise.all([
          computeCausalOrder(id, userId),
          detectThreads(id, userId),
          findPivotalNodes(id, userId),
          findCausalGaps(id, userId),
        ]);

      const existingThreads = await graphThreads.getThreadsForDocument(
        id,
        userId,
      );

      const existingThreadsWithMembers = await Promise.all(
        existingThreads.map(async (thread) => {
          const memberships = await graphThreads.getEventsForThread(thread.id);
          return {
            ...thread,
            memberNodeIds: memberships.map((m) => m.eventId),
          };
        }),
      );

      res.json({
        causalOrder,
        detectedThreads: threads,
        existingThreads: existingThreadsWithMembers,
        pivotalNodes,
        causalGaps,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/node-layout-projection',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      const projection = await graphService.getNodeEmbeddingsProjection(
        id,
        userId,
      );

      res.json({ projection });
    } catch (error) {
      next(error);
    }
  },
);

// Entity similarity endpoint
import { entityDocumentSimilarityService } from '../services/semantics/entityDocumentSimilarity.service';

router.get(
  '/documents/:id/entity-similarity/:entityId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const entityId = parseStringParam(req.params.entityId, 'entityId');

      await documentsService.get(id, userId);

      const result =
        await entityDocumentSimilarityService.computeEntitySimilarityForDocument(
          id,
          entityId,
          userId,
        );

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// Character arc endpoint
router.get(
  '/documents/:id/character-arc/:characterId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const characterId = parseStringParam(
        req.params.characterId,
        'characterId',
      );

      // Verify user has access to document
      await documentsService.get(id, userId);

      // Get arcs, states, and transitions for the character
      const [arcs, states, transitions] = await Promise.all([
        graphService.getCharacterArcs(characterId),
        graphService.getCharacterStates(characterId),
        graphService.getStateTransitions(characterId),
      ]);

      // For each arc, get its states via INCLUDES_STATE
      const arcsWithStates = await Promise.all(
        arcs.map(async (arc) => {
          const arcStates = await graphService.getArcStates(arc.id);
          return {
            id: arc.id,
            name: arc.name,
            arcType: arc.arcType,
            states: arcStates.map((s) => ({
              id: s.id,
              name: s.name,
              description: '', // States don't have description, use name
              documentOrder: s.documentOrder,
            })),
            transitions: transitions
              .filter((t) => arcStates.some((s) => s.id === t.fromStateId))
              .map((t) => ({
                fromStateId: t.fromStateId,
                toStateId: t.toStateId,
                gapDetected: t.gapDetected,
                triggerEventId: t.triggerEventId,
              })),
          };
        }),
      );

      // If no arcs exist but states do, create a default arc from all states
      if (arcsWithStates.length === 0 && states.length > 0) {
        arcsWithStates.push({
          id: 'default',
          name: 'Arc',
          arcType: 'growth',
          states: states.map((s) => ({
            id: s.id,
            name: s.name,
            description: '',
            documentOrder: s.documentOrder,
          })),
          transitions: transitions
            .filter((t) => states.some((s) => s.id === t.fromStateId))
            .map((t) => ({
              fromStateId: t.fromStateId,
              toStateId: t.toStateId,
              gapDetected: t.gapDetected,
              triggerEventId: t.triggerEventId,
            })),
        });
      }

      res.json({ characterId, arcs: arcsWithStates });
    } catch (error) {
      next(error);
    }
  },
);

// Thread management endpoints

router.post(
  '/documents/:id/threads',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { name, isPrimary } = req.body;

      await documentsService.get(id, userId);

      const threadId = await graphService.createNarrativeThread(id, userId, {
        name: name || 'Untitled Thread',
        isPrimary: isPrimary ?? false,
        eventNames: [],
      });

      res.status(201).json({ threadId });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/threads/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const { name } = req.body;

      const thread = await graphThreads.getThreadById(id);
      if (!thread) {
        res
          .status(404)
          .json({ error: { message: 'Thread not found', code: 'NOT_FOUND' } });
        return;
      }

      if (name) await graphThreads.renameThread(id, name);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/threads/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');

      const thread = await graphThreads.getThreadById(id);
      if (!thread) {
        res
          .status(404)
          .json({ error: { message: 'Thread not found', code: 'NOT_FOUND' } });
        return;
      }

      await graphThreads.deleteThread(id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/threads/:id/members',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const { nodeId, order } = req.body;

      await graphThreads.addEventToThread(nodeId, id, order ?? 0);
      res.status(201).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/threads/:id/members/:nodeId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const nodeId = parseStringParam(req.params.nodeId, 'nodeId');

      await graphThreads.removeEventFromThread(nodeId, id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/detect-threads',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);
      const threads = await detectThreads(id, userId);

      res.json({ threads });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/upgrade-analysis-version',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      const document = await documentsService.get(id, userId);

      const fromVersion = document.analysisVersion ?? '0.0.1';
      const toVersion = getCurrentAnalysisVersion();

      // Check if upgrade needed
      const diff = getVersionDiff(fromVersion, toVersion);
      if (!diff.requiresReanalysis) {
        res.status(400).json({
          error: {
            code: 'NO_UPGRADE_NEEDED',
            message: `Document already at version ${toVersion}`,
          },
        });
        return;
      }

      // Check for active jobs on this document
      const activeJobs = await jobService.getJobsForTarget('document', id, [
        'queued',
        'processing',
        'paused',
      ]);
      if (activeJobs.length > 0) {
        res.status(409).json({
          error: {
            code: 'OPERATION_IN_PROGRESS',
            message: 'Cannot upgrade: another operation is in progress',
          },
        });
        return;
      }

      // Atomically set status to upgrading (only if null)
      const updateResult = await db
        .update(documents)
        .set({ analysisStatus: 'upgrading' })
        .where(and(eq(documents.id, id), isNull(documents.analysisStatus)))
        .returning({ id: documents.id });

      if (updateResult.length === 0) {
        // Status was not null, another operation is in progress
        res.status(409).json({
          error: {
            code: 'OPERATION_IN_PROGRESS',
            message: 'Cannot upgrade: another operation is in progress',
          },
        });
        return;
      }

      // Create upgrade job
      const job = await jobService.create({
        type: 'analysis_version_upgrade',
        targetType: 'document',
        targetId: id,
        userId,
        payload: { fromVersion, toVersion, documentTitle: document.title },
      });

      if (!job) {
        // Race condition - clear status and return error
        await db
          .update(documents)
          .set({ analysisStatus: null })
          .where(eq(documents.id, id));

        res.status(409).json({
          error: {
            code: 'OPERATION_IN_PROGRESS',
            message: 'Upgrade job could not be created',
          },
        });
        return;
      }

      res.status(202).json({
        jobId: job.id,
        fromVersion,
        toVersion,
        message: 'Upgrade queued',
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;

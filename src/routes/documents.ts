import { eq, inArray } from 'drizzle-orm';
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { db } from '../config/database';
import { jobService } from '../jobs/service';
import { requireAuth } from '../middleware/auth';
import {
  analysisSnapshots,
  documents,
  jobs,
  media,
  mentions,
} from '../models/schema';
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
import { s3 } from '../services/s3';
import { sseService } from '../services/sse';
import { stalenessService } from '../services/staleness';
import { graphStoryNodesRepository } from '../services/storyNodes';
import { UsageQuotaExceededError, usageService } from '../services/usage';
import { versioningService } from '../services/versioning';
import { logger } from '../utils/logger';

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

router.get(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;
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
      const { title } = req.body;
      const document = await documentsService.copy(
        req.params.id,
        userId,
        title || 'Untitled',
      );
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
      const { id } = req.params;
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
      const { id } = req.params;
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
      const { id, versionNumber } = req.params;

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
      const { id } = req.params;
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
      const { id } = req.params;
      await documentsService.delete(id, userId);
      res.json({ success: true });
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
      const { id } = req.params;
      await documentsService.get(id, userId);
      const media = await mediaService.getDocumentMedia(id);
      res.json({ media });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/media/stream',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;
      await documentsService.get(id, userId);

      const clientId = `${userId}-${id}-${Date.now()}`;
      sseService.addClient(clientId, `document:${id}`, res);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/stream',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;
      await documentsService.get(id, userId);

      const sessionId =
        (req.query.sessionId as string) || `${userId}-${Date.now()}`;
      const clientId = `doc-${id}-${sessionId}`;

      sseService.addClient(clientId, `document:${id}`, res);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/analysis-status',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;

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
      const { id } = req.params;

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
      const { id } = req.params;
      const reanalyze = req.query.reanalyze === 'true';

      const document = await documentsService.get(id, userId);

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
      const { id } = req.params;

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
      const { id } = req.params;

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
      const { id } = req.params;

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
      const { id } = req.params;

      // Fetch active story nodes from FalkorDB
      const nodes = await graphStoryNodesRepository.getActiveNodes(id, userId);

      // Fetch active connections from FalkorDB
      const connections =
        nodes.length > 0
          ? await graphStoryNodesRepository.getConnectionsForDocument(id)
          : [];

      const nodesWithPrimaryMedia = nodes.filter((n) => n.primaryMediaId);
      const primaryMediaUrls: Record<string, string> = {};

      if (nodesWithPrimaryMedia.length > 0) {
        const mediaIds = nodesWithPrimaryMedia.map((n) => n.primaryMediaId!);
        const mediaRecords = await db
          .select({
            id: media.id,
            s3KeyThumb: media.s3KeyThumb,
            s3Key: media.s3Key,
          })
          .from(media)
          .where(inArray(media.id, mediaIds));

        for (const m of mediaRecords) {
          const key = m.s3KeyThumb || m.s3Key;
          if (key) {
            try {
              primaryMediaUrls[m.id] = await s3.generateDownloadUrl(key);
            } catch {
              // Skip if URL generation fails
            }
          }
        }
      }

      const nodesWithUrls = nodes.map((n) => ({
        ...n,
        primaryMediaUrl: n.primaryMediaId
          ? primaryMediaUrls[n.primaryMediaId]
          : null,
      }));

      res.json({ nodes: nodesWithUrls, connections });
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
      const { id } = req.params;

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
      const { id } = req.params;

      logger.info({ documentId: id, userId }, 'DELETE story-nodes called');

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
      const { id } = req.params;
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
      const { id } = req.params;

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
      const { id } = req.params;

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

// Thread management endpoints

router.post(
  '/documents/:id/threads',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;
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
      const { id } = req.params;
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
      const { id } = req.params;

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
      const { id } = req.params;
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
      const { id, nodeId } = req.params;

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
      const { id } = req.params;

      await documentsService.get(id, userId);
      const threads = await detectThreads(id, userId);

      res.json({ threads });
    } catch (error) {
      next(error);
    }
  },
);

export default router;

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../config/database';
import { calculateLLMCost } from '../config/pricing';
import { requireAuth } from '../middleware/auth';
import {
  analysisChatMessages,
  analysisChats,
  documents,
  textTypeAnnotations,
} from '../models/schema';
import { analysisClient } from '../services/analysisClient';
import type { CreateMentionInput } from '../services/mentions';
import { fuzzyFindTextInSegment, mentionService } from '../services/mentions';
import { redis } from '../services/redis';
import { segmentService } from '../services/segments';
import { sseService } from '../services/sse';
import { usageTrackingService } from '../services/usageTracking/usageTrackingService';
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
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

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

      const existingSegments =
        await segmentService.getDocumentSegments(documentId);

      let segments = existingSegments;
      if (doc.content?.length > 0) {
        segments = segmentService.computeSegments(
          doc.content,
          existingSegments,
        );
        await db
          .update(documents)
          .set({ segmentSequence: segments })
          .where(eq(documents.id, documentId));
      }

      logger.info(
        {
          documentId,
          contentLength: doc.content?.length ?? 0,
          existingSegmentCount: existingSegments.length,
          newSegmentCount: segments.length,
        },
        'Analysis trigger: segment computation',
      );

      if (segments.length === 0) {
        res.status(400).json({ error: 'Document has no content to analyze' });
        return;
      }

      const domain = req.body.domain || null;
      const settings = doc.analysisSettings as {
        enabledLayers?: string[];
        automationLevel?: string;
        confidenceThreshold?: number;
      } | null;
      const enabledLayers = req.body.enabledLayers ||
        settings?.enabledLayers || ['foundation'];
      const automationLevel =
        req.body.automationLevel || settings?.automationLevel || 'full_auto';
      const confidenceThreshold =
        req.body.confidenceThreshold ?? settings?.confidenceThreshold ?? 0.75;

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
        enabled_layers: enabledLayers,
        requested_stages: req.body.stages || undefined,
        segment_ids: req.body.segment_ids || undefined,
        automation_level: automationLevel,
        confidence_threshold: confidenceThreshold,
      });

      await redis.set(lockKey, run_id, 600);

      subscribeToAnalysisProgress(run_id, documentId);

      res.json({ runId: run_id });
    } catch (error) {
      next(error);
    }
  },
);

// --- Resume endpoint (HITL) ---

router.post(
  '/analysis/documents/:id/runs/:runId/resume',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const runId = parseStringParam(req.params.runId, 'runId');
      if (!req.user) throw new Error('User not authenticated');

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const { approved_ids = [], dismissed_ids = [] } = req.body;
      const result = await analysisClient.resumeRun(runId, documentId, {
        approved_ids,
        dismissed_ids,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// --- Cancel endpoint ---

router.post(
  '/analysis/documents/:id/cancel',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');

      const lockKey = `analysis:lock:${documentId}`;
      const runId = await redis.get(lockKey);
      if (!runId) {
        res.status(404).json({ error: 'No active analysis run' });
        return;
      }

      await analysisClient.cancelRun(runId, documentId);
      await redis.del(lockKey);
      res.json({ cancelled: true });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/analysis/documents/:id/run-state',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const lockKey = `analysis:lock:${documentId}`;
      const runId = await redis.get(lockKey);
      if (!runId) {
        res.json({ runId: null, status: null });
        return;
      }

      const isInterrupted = await redis.get(`analysis:interrupted:${runId}`);
      const status = isInterrupted ? 'interrupted' : 'running';

      // Re-establish the Redis subscription in case core restarted since the run began.
      // subscribeChannel is idempotent — safe to call if already subscribed.
      subscribeToAnalysisProgress(runId, documentId);

      res.json({ runId, status });
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
      const {
        domain,
        enabledLayers,
        automationLevel,
        confidenceThreshold,
        retriggerSizePct,
      } = req.body;
      // Merge rather than replace — preserves classifiedDomain/classifiedAt and any other
      // fields written by other endpoints (e.g. the classify endpoint).
      const existing =
        (doc.analysisSettings as Record<string, unknown> | null) ?? {};
      await db
        .update(documents)
        .set({
          analysisSettings: {
            ...existing,
            domain,
            enabledLayers,
            automationLevel,
            ...(confidenceThreshold !== undefined && { confidenceThreshold }),
            ...(retriggerSizePct !== undefined && { retriggerSizePct }),
          },
        })
        .where(eq(documents.id, documentId));
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// --- Part 4b: Domain classification ---

router.post(
  '/analysis/documents/:id/classify',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const settings = doc.analysisSettings as {
        classifiedDomain?: string;
        classifiedAt?: string;
      } | null;

      // Return cached result unless explicitly forced
      const forceRefresh = req.body?.force === true;
      if (!forceRefresh && settings?.classifiedDomain) {
        res.json({ domain: settings.classifiedDomain, cached: true });
        return;
      }

      const sampleText = doc.content?.slice(0, 2000) || '';
      if (!sampleText.trim()) {
        res.json({ domain: null, cached: false });
        return;
      }

      const result = await analysisClient.classify({
        document_id: documentId,
        sample_text: sampleText,
      });

      // Persist classification result alongside existing settings
      const existing =
        (doc.analysisSettings as Record<string, unknown> | null) ?? {};
      await db
        .update(documents)
        .set({
          analysisSettings: {
            ...existing,
            classifiedDomain: result.domain,
            classifiedAt: new Date().toISOString(),
          },
        })
        .where(eq(documents.id, documentId));

      res.json({ ...result, cached: false });
    } catch (error) {
      next(error);
    }
  },
);

// --- Part 5: Chat CRUD ---

router.post(
  '/analysis/documents/:id/chats',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== userId) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const [chat] = await db
        .insert(analysisChats)
        .values({
          documentId,
          userId,
          title: req.body.title || null,
        })
        .returning();

      res.status(201).json(chat);
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/analysis/documents/:id/chats',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== userId) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const chats = await db.query.analysisChats.findMany({
        where: and(
          eq(analysisChats.documentId, documentId),
          eq(analysisChats.userId, userId),
        ),
        orderBy: [asc(analysisChats.createdAt)],
      });

      res.json({ chats });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/analysis/documents/:id/chats/:chatId',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const chatId = parseStringParam(req.params.chatId, 'chatId');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const chat = await db.query.analysisChats.findFirst({
        where: and(
          eq(analysisChats.id, chatId),
          eq(analysisChats.documentId, documentId),
          eq(analysisChats.userId, userId),
        ),
        with: {
          messages: {
            orderBy: [asc(analysisChatMessages.createdAt)],
          },
        },
      });

      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      res.json(chat);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/analysis/documents/:id/chats/:chatId/messages',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const chatId = parseStringParam(req.params.chatId, 'chatId');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const chat = await db.query.analysisChats.findFirst({
        where: and(
          eq(analysisChats.id, chatId),
          eq(analysisChats.documentId, documentId),
          eq(analysisChats.userId, userId),
        ),
      });
      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      const { role, content, metadata } = req.body;
      if (!role || !content) {
        res.status(400).json({ error: 'role and content are required' });
        return;
      }

      const [message] = await db
        .insert(analysisChatMessages)
        .values({
          chatId,
          role,
          content,
          metadata: metadata || {},
        })
        .returning();

      await db
        .update(analysisChats)
        .set({ updatedAt: new Date() })
        .where(eq(analysisChats.id, chatId));

      // For user messages, get a chat response from the analysis service
      let assistantResponse: string | undefined;

      if (role === 'user') {
        // Load non-compacted messages
        const allMessages = await db.query.analysisChatMessages.findMany({
          where: and(
            eq(analysisChatMessages.chatId, chatId),
            isNull(analysisChatMessages.compactedAt),
          ),
          orderBy: [asc(analysisChatMessages.createdAt)],
        });

        const COMPACTION_THRESHOLD = 30;
        const KEEP_RECENT = 20;

        // Compact older messages if over threshold
        if (allMessages.length > COMPACTION_THRESHOLD) {
          const toCompact = allMessages.slice(
            0,
            allMessages.length - KEEP_RECENT,
          );
          const compactable = toCompact.filter(
            (m) => m.role === 'user' || m.role === 'assistant',
          );

          if (compactable.length > 0) {
            try {
              const { summary } = await analysisClient.compactMessages(
                compactable.map((m) => ({ role: m.role, content: m.content })),
              );

              // Store summary as a new message
              await db.insert(analysisChatMessages).values({
                chatId,
                role: 'summary',
                content: summary,
                metadata: { compactedCount: toCompact.length },
              });

              // Mark compacted messages
              const compactIds = toCompact.map((m) => m.id);
              for (const id of compactIds) {
                await db
                  .update(analysisChatMessages)
                  .set({ compactedAt: new Date() })
                  .where(eq(analysisChatMessages.id, id));
              }
            } catch (e) {
              logger.error(
                { e },
                'Chat compaction failed, continuing with full history',
              );
            }
          }
        }

        // Build chat history: summary (if any) + recent non-compacted
        const summaryMsg = await db.query.analysisChatMessages.findFirst({
          where: and(
            eq(analysisChatMessages.chatId, chatId),
            eq(analysisChatMessages.role, 'summary'),
          ),
          orderBy: [asc(analysisChatMessages.createdAt)],
        });

        const recentMessages = await db.query.analysisChatMessages.findMany({
          where: and(
            eq(analysisChatMessages.chatId, chatId),
            isNull(analysisChatMessages.compactedAt),
          ),
          orderBy: [asc(analysisChatMessages.createdAt)],
          limit: KEEP_RECENT,
        });

        const chatHistory: Array<{ role: string; content: string }> = [];
        if (summaryMsg) {
          chatHistory.push({
            role: 'system',
            content: `Previous conversation summary:\n${summaryMsg.content}`,
          });
        }
        for (const m of recentMessages) {
          if (m.role === 'summary') continue;
          chatHistory.push({ role: m.role, content: m.content });
        }

        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, documentId),
        });
        const totalSegments = doc?.segmentSequence
          ? (doc.segmentSequence as string[]).length
          : undefined;

        try {
          const chatResult = await analysisClient.chat({
            document_id: documentId,
            user_id: userId,
            message: content,
            chat_history: chatHistory,
            total_segments: totalSegments,
          });
          assistantResponse = chatResult.response;

          const metadata: Record<string, unknown> = {};
          if (chatResult.proposed_action) {
            metadata.proposed_action = chatResult.proposed_action;
          }

          if (assistantResponse) {
            await db.insert(analysisChatMessages).values({
              chatId,
              role: 'assistant',
              content: assistantResponse,
              metadata,
            });
          }

          res.status(201).json({
            ...message,
            assistantResponse,
            proposedAction: chatResult.proposed_action || null,
          });
          return;
        } catch (e) {
          logger.error({ e, documentId }, 'Chat request failed');
        }
      }

      res.status(201).json({ ...message, assistantResponse });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/analysis/documents/:id/chats/:chatId',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      const chatId = parseStringParam(req.params.chatId, 'chatId');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const chat = await db.query.analysisChats.findFirst({
        where: and(
          eq(analysisChats.id, chatId),
          eq(analysisChats.documentId, documentId),
          eq(analysisChats.userId, userId),
        ),
      });
      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      await db.delete(analysisChats).where(eq(analysisChats.id, chatId));
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// --- Coverage endpoint ---

router.get(
  '/analysis/documents/:id/coverage',
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
      const segments =
        (doc.segmentSequence as Array<{
          id: string;
          start: number;
          end: number;
        }>) || [];
      const result = await analysisClient.getCoverage(
        documentId,
        segments.length,
      );

      if (result.percentage && segments.length > 0 && doc.content) {
        try {
          const storedHashes =
            await analysisClient.getCoverageHashes(documentId);
          let stale = 0;
          for (const seg of segments) {
            const storedHash = storedHashes[seg.id];
            if (!storedHash) continue;
            const currentText = doc.content.slice(seg.start, seg.end);
            const currentHash = createHash('sha256')
              .update(currentText)
              .digest('hex')
              .slice(0, 16);
            if (currentHash !== storedHash) stale++;
          }
          result.percentage.stale = stale;
        } catch {
          logger.warn(
            { documentId },
            'Failed to fetch coverage hashes for staleness detection',
          );
        }
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// --- Domain change endpoint ---

const SOCIAL_TYPES = ['CONNECTED_TO', 'OPPOSES'];

const DOMAIN_LAYER_TYPES: Record<string, string[]> = {
  narrative: SOCIAL_TYPES,
};

function getTypesToRemove(fromDomain: string, toDomain: string): string[] {
  const fromTypes = DOMAIN_LAYER_TYPES[fromDomain] ?? [];
  const toTypes = DOMAIN_LAYER_TYPES[toDomain] ?? [];
  const toSet = new Set(toTypes);
  return fromTypes.filter((t) => !toSet.has(t));
}

router.post(
  '/analysis/documents/:id/change-domain',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== req.user.id) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const { targetDomain } = req.body;
      if (!targetDomain) {
        res.status(400).json({ error: 'targetDomain required' });
        return;
      }

      const existing =
        (doc.analysisSettings as Record<string, unknown> | null) ?? {};
      const currentDomain = (existing.domain as string) ?? 'general';
      const typesToRemove = getTypesToRemove(currentDomain, targetDomain);

      let deletedCount = 0;
      if (typesToRemove.length > 0) {
        const result = await analysisClient.softDeleteConnectionsByTypes(
          documentId,
          typesToRemove,
        );
        deletedCount = result.deleted;
      }

      await db
        .update(documents)
        .set({
          analysisSettings: {
            ...existing,
            domain: targetDomain,
          },
        })
        .where(eq(documents.id, documentId));

      res.json({
        previousDomain: currentDomain,
        newDomain: targetDomain,
        deletedConnections: deletedCount,
        removedTypes: typesToRemove,
      });
    } catch (error) {
      next(error);
    }
  },
);

// --- Events endpoint ---

router.get(
  '/analysis/documents/:id/events',
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
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const result = await analysisClient.getEvents(documentId, limit, offset);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// --- Delete entities endpoint ---

router.delete(
  '/analysis/documents/:id/entities',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const documentId = parseStringParam(req.params.id, 'id');
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc || doc.userId !== userId) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const result = await analysisClient.deleteEntities(documentId);

      await redis.del(`analysis:lock:${documentId}`);

      // Clear mentions from Postgres
      await mentionService.deleteByDocumentId(documentId);

      // Invalidate layout positions
      await db
        .update(documents)
        .set({ layoutPositions: null })
        .where(eq(documents.id, documentId));

      res.json(result);
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

        if (data.status === 'interrupted') {
          // Pipeline paused for HITL review — extend lock to match interrupt TTL (1 hour)
          // so a new analysis cannot start while proposals are pending.
          redis.expire(lockKey, 3600).catch(() => {});
        } else if (data.stage === 'pipeline' || data.status === 'cancelled') {
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

            persistTextTypesAfterAnalysis(documentId).catch((e) => {
              logger.error(
                { e, documentId },
                'Failed to persist text types after analysis',
              );
            });

            if (data.chat_response) {
              persistPipelineChatResponse(documentId, data.chat_response).catch(
                (e) => {
                  logger.error(
                    { e, documentId },
                    'Failed to persist pipeline chat response',
                  );
                },
              );
            }

            if (data.llm_usage?.length) {
              recordAnalysisUsageBatch(documentId, runId, data.llm_usage).catch(
                (e) => {
                  logger.error(
                    { e, documentId },
                    'Failed to record analysis usage batch',
                  );
                },
              );
            }
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
  const segments =
    (doc.segmentSequence as Array<{
      id: string;
      start: number;
      end: number;
    }>) || [];

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
        if (!segment || !doc.content) continue;
        const segmentText = doc.content.slice(segment.start, segment.end);

        const exactIdx = segmentText.indexOf(m.text);
        if (exactIdx !== -1) {
          relativeStart = exactIdx;
          relativeEnd = exactIdx + m.text.length;
          recovered++;
        } else {
          const fuzzyResult = fuzzyFindTextInSegment(
            doc.content,
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
        versionNumber: doc.currentVersion,
        source: 'extraction',
      });
    }
  }

  if (inputs.length > 0) {
    await mentionService.createBatch(inputs);
    logger.info(
      { documentId, mentionCount: inputs.length, recoveredOffsets: recovered },
      'Persisted mentions after analysis',
    );
  }

  // Invalidate cached PCA layout so projection recomputes with new embeddings
  await db
    .update(documents)
    .set({ layoutPositions: null })
    .where(eq(documents.id, documentId));
}

async function persistTextTypesAfterAnalysis(
  documentId: string,
): Promise<void> {
  const { annotations } = await analysisClient.getTextTypes(documentId);
  if (!annotations.length) return;

  // Collect affected segment IDs for delete-then-insert idempotency
  const segmentIds = [...new Set(annotations.map((a) => a.segment_id))];

  // Delete existing annotations for affected segments
  for (const segId of segmentIds) {
    await db
      .delete(textTypeAnnotations)
      .where(
        and(
          eq(textTypeAnnotations.documentId, documentId),
          eq(textTypeAnnotations.segmentId, segId),
        ),
      );
  }

  // Insert new annotations
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });

  const rows = annotations.map((a) => ({
    documentId,
    segmentId: a.segment_id,
    textType: a.text_type,
    relativeStart: a.char_start,
    relativeEnd: a.char_end,
    boundaryText: a.boundary_text || '',
    textHash: a.text_hash,
    confidence: a.confidence,
    versionNumber: doc?.currentVersion ?? 1,
  }));

  await db.insert(textTypeAnnotations).values(rows);

  logger.info(
    { documentId, annotationCount: rows.length, segments: segmentIds.length },
    'Persisted text type annotations after analysis',
  );
}

async function persistPipelineChatResponse(
  documentId: string,
  response: string,
): Promise<void> {
  const chat = await db.query.analysisChats.findFirst({
    where: eq(analysisChats.documentId, documentId),
    orderBy: [desc(analysisChats.updatedAt)],
  });
  if (!chat) return;

  await db.insert(analysisChatMessages).values({
    chatId: chat.id,
    role: 'assistant',
    content: response,
    metadata: { source: 'pipeline' },
  });

  await db
    .update(analysisChats)
    .set({ updatedAt: new Date() })
    .where(eq(analysisChats.id, chat.id));
}

interface AnalysisUsageRecord {
  operation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

async function recordAnalysisUsageBatch(
  documentId: string,
  runId: string,
  records: AnalysisUsageRecord[],
): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) return;

  for (const record of records) {
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
        'Unknown model for cost calculation, recording with zero cost',
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

// --- Proposals proxy ---

router.get(
  '/analysis/proposals/:documentId',
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
      const result = await analysisClient.getProposals(documentId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export { router as analysisRouter };

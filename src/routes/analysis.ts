import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../config/database';
import { calculateLLMCost } from '../config/pricing';
import { requireAuth } from '../middleware/auth';
import {
  analysisChatMessages,
  analysisChats,
  documents,
} from '../models/schema';
import { analysisClient } from '../services/analysisClient';
import type { CreateMentionInput } from '../services/mentions';
import { mentionService } from '../services/mentions';
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
      const enabledLayers = req.body.enabledLayers || settings?.enabledLayers || ['foundation'];
      const automationLevel = req.body.automationLevel || settings?.automationLevel || 'full_auto';
      const confidenceThreshold = req.body.confidenceThreshold ?? settings?.confidenceThreshold ?? 0.75;

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

      await analysisClient.cancelRun(runId);
      await redis.del(lockKey);
      res.json({ cancelled: true });
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
      const { domain, enabledLayers, automationLevel, confidenceThreshold, retriggerSizePct } = req.body;
      await db
        .update(documents)
        .set({ analysisSettings: { domain, enabledLayers, automationLevel, confidenceThreshold, retriggerSizePct } })
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

      const result = await analysisClient.classify({ document_id: documentId, sample_text: sampleText });

      // Persist classification result alongside existing settings
      const existing = (doc.analysisSettings as Record<string, unknown> | null) ?? {};
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

        try {
          const chatResult = await analysisClient.chat({
            document_id: documentId,
            user_id: userId,
            message: content,
            chat_history: chatHistory,
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
      const segmentSequence = (doc.segmentSequence as string[]) || [];
      const result = await analysisClient.getCoverage(
        documentId,
        segmentSequence.length,
      );
      res.json(result);
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

        if (data.stage === 'pipeline' || data.status === 'cancelled') {
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

  // Invalidate cached PCA layout so projection recomputes with new embeddings
  await db
    .update(documents)
    .set({ layoutPositions: null })
    .where(eq(documents.id, documentId));
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

router.post(
  '/analysis/proposals/:proposalId/approve',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const proposalId = parseStringParam(req.params.proposalId, 'proposalId');
      const result = await analysisClient.approveProposal(proposalId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/analysis/proposals/:proposalId/dismiss',
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const proposalId = parseStringParam(req.params.proposalId, 'proposalId');
      const result = await analysisClient.dismissProposal(proposalId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export { router as analysisRouter };

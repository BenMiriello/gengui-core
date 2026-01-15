import { db } from '../config/database';
import { media, documentMedia, documents } from '../models/schema';
import { eq, and } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { redis } from './redis';
import { redisStreams } from './redis-streams';
import { runpodClient, RUNPOD_CONSTANTS } from './runpod';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface PromptEnhancement {
  enabled: boolean;
  charsBefore: number;
  charsAfter: number;
  useNarrativeContext: boolean;
  sceneTreatment: 'comprehensive' | 'focused' | 'selective-detail';
  selectiveDetailFocus?: string;
  strength: 'low' | 'medium' | 'high';
}

export interface GenerationRequest {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  documentId?: string;
  startChar?: number;
  endChar?: number;
  sourceText?: string;
  nodePos?: number;
  textOffset?: number;
  contextBefore?: string;
  contextAfter?: string;
  promptEnhancement?: PromptEnhancement;
}

export class GenerationsService {
  async create(userId: string, request: GenerationRequest) {
    const startTime = Date.now();

    const seed = request.seed ?? Math.floor(Math.random() * 1000000);
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;

    let stylePreset: string | null = null;
    let stylePrompt: string | null = null;

    if (request.documentId) {
      const [document] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.documentId))
        .limit(1);

      if (document) {
        stylePreset = document.defaultStylePreset;
        stylePrompt = document.defaultStylePrompt;
      }
    }

    // Determine initial status based on whether augmentation is enabled
    const initialStatus = request.promptEnhancement?.enabled ? 'augmenting' : 'queued';

    const [newMedia] = await db
      .insert(media)
      .values({
        userId,
        type: 'generation',
        status: initialStatus,
        prompt: request.prompt,
        seed,
        width,
        height,
        stylePreset,
        stylePrompt,
      })
      .returning();

    if (request.documentId) {
      let contextBefore: string | undefined = request.contextBefore;
      let contextAfter: string | undefined = request.contextAfter;

      if (!contextBefore && !contextAfter && request.startChar !== undefined && request.endChar !== undefined) {
        const [document] = await db
          .select()
          .from(documents)
          .where(eq(documents.id, request.documentId))
          .limit(1);

        if (document) {
          const CONTEXT_LENGTH = 50;
          const content = document.content;

          const contextBeforeStart = Math.max(0, request.startChar - CONTEXT_LENGTH);
          contextBefore = content.substring(contextBeforeStart, request.startChar);

          const contextAfterEnd = Math.min(content.length, request.endChar + CONTEXT_LENGTH);
          contextAfter = content.substring(request.endChar, contextAfterEnd);
        }
      }

      await db.insert(documentMedia).values({
        documentId: request.documentId,
        mediaId: newMedia.id,
        startChar: request.startChar,
        endChar: request.endChar,
        sourceText: request.sourceText,
        nodePos: request.nodePos,
        textOffset: request.textOffset,
        contextBefore,
        contextAfter,
        requestedPrompt: request.prompt,
      });
    }

    try {
      // Check if augmentation is enabled
      if (request.promptEnhancement?.enabled) {
        // Augmentation flow: Queue to prompt-augmentation:stream
        if (!request.documentId || request.startChar === undefined || request.endChar === undefined) {
          throw new Error('Document ID, startChar, and endChar are required for prompt augmentation');
        }

        await redisStreams.add('prompt-augmentation:stream', {
          mediaId: newMedia.id,
          userId,
          documentId: request.documentId,
          selectedText: request.sourceText || request.prompt,
          startChar: request.startChar.toString(),
          endChar: request.endChar.toString(),
          settings: JSON.stringify(request.promptEnhancement),
          stylePrompt: stylePrompt || '',
          seed: seed.toString(),
          width: width.toString(),
          height: height.toString(),
        });

        // Track augmentation for rate limiting
        const now = new Date();
        const todayUTC = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        );
        const dateStr = todayUTC.toISOString().split('T')[0];
        const augmentationKey = `user:${userId}:augmentations:${dateStr}`;
        await redis.zadd(augmentationKey, Date.now(), newMedia.id);
        await redis.expire(augmentationKey, 172800); // 48h TTL for cleanup
      } else {
        // Direct generation flow (no augmentation)
        // Submit to RunPod or Redis based on configuration
        if (runpodClient.isEnabled()) {
          // RunPod mode: Submit to RunPod API with per-job timeout
          const runpodJobId = await runpodClient.submitJob(
            {
              mediaId: newMedia.id,
              userId,
              prompt: request.prompt,
              seed: seed.toString(),
              width: width.toString(),
              height: height.toString(),
            },
            {
              executionTimeout: RUNPOD_CONSTANTS.EXECUTION_TIMEOUT_MS,
            }
          );

          // Store RunPod job ID and submission timestamp in Redis for reconciliation
          await redis.set(`runpod:job:${newMedia.id}`, runpodJobId, RUNPOD_CONSTANTS.REDIS_JOB_TTL_SECONDS);
          await redis.set(`runpod:job:${newMedia.id}:submitted`, Date.now().toString(), RUNPOD_CONSTANTS.REDIS_JOB_TTL_SECONDS);

          logger.info(
            { mediaId: newMedia.id, runpodJobId, prompt: request.prompt },
            'Generation submitted to RunPod'
          );
        } else {
          // Local/Redis mode: Queue in Redis stream for worker polling
          await redisStreams.add('generation:stream', {
            userId,
            mediaId: newMedia.id,
            prompt: request.prompt,
            seed: seed.toString(),
            width: width.toString(),
            height: height.toString(),
            status: 'queued',
          });

          logger.info({ mediaId: newMedia.id, prompt: request.prompt }, 'Generation queued in Redis stream');
        }

        // Track generation for rate limiting
        const now = new Date();
        const todayUTC = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        );
        const dateStr = todayUTC.toISOString().split('T')[0];
        const rateLimitKey = `user:${userId}:generations:${dateStr}`;
        await redis.zadd(rateLimitKey, Date.now(), newMedia.id);
        await redis.expire(rateLimitKey, 172800); // 48h TTL for cleanup
      }
    } catch (error) {
      logger.error({ error, mediaId: newMedia.id }, 'Failed to queue generation, marking as failed');
      await db
        .update(media)
        .set({ status: 'failed', error: 'Failed to queue job' })
        .where(eq(media.id, newMedia.id));
      throw error;
    }

    logger.info({ userId, mediaId: newMedia.id, totalElapsed: Date.now() - startTime }, '[TIMING] generationsService.create COMPLETE');
    return newMedia;
  }

  async getById(id: string, userId: string) {
    const result = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.id, id),
          eq(media.userId, userId),
          eq(media.type, 'generation'),
          notDeleted(media.deletedAt)
        )
      )
      .limit(1);

    if (result.length === 0) {
      throw new NotFoundError('Generation not found');
    }

    return result[0];
  }

  async list(userId: string, limit: number = 50) {
    const results = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.userId, userId),
          eq(media.type, 'generation'),
          notDeleted(media.deletedAt)
        )
      )
      .orderBy(media.createdAt)
      .limit(limit);

    return results;
  }

  /**
   * Cancel a generation job
   * Race-condition safe: checks RunPod status before cancelling
   * Returns 409 if job already completed
   */
  async cancel(id: string, userId: string) {
    // Verify ownership
    const job = await this.getById(id, userId);

    // Already cancelled
    if (job.cancelledAt) {
      logger.info({ mediaId: id }, 'Job already cancelled');
      return { cancelled: true, alreadyCancelled: true };
    }

    // Already completed/failed - can't cancel
    if (job.status === 'completed' || job.status === 'failed') {
      logger.info({ mediaId: id, status: job.status }, 'Job already finished, cannot cancel');
      throw new Error(`Job already ${job.status}`);
    }

    // RunPod mode: Check status with RunPod API first to avoid race conditions
    if (runpodClient.isEnabled()) {
      const runpodJobId = await redis.get(`runpod:job:${id}`);

      if (!runpodJobId) {
        // No RunPod job ID - maybe never submitted or Redis expired
        // Just mark as cancelled in DB
        logger.warn({ mediaId: id }, 'No RunPod job ID found, marking as cancelled in DB');
        await db
          .update(media)
          .set({ cancelledAt: new Date(), status: 'failed', error: 'Cancelled by user' })
          .where(eq(media.id, id));
        return { cancelled: true };
      }

      try {
        // Check current RunPod status
        const status = await runpodClient.getJobStatus(runpodJobId);

        // Already completed - show result instead of cancelling
        if (status.status === 'COMPLETED') {
          logger.info({ mediaId: id, runpodJobId }, 'Job completed before cancellation');
          throw new Error('Job already completed');
        }

        // Try to cancel on RunPod
        if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
          try {
            await runpodClient.cancelJob(runpodJobId);
            logger.info({ mediaId: id, runpodJobId }, 'Job cancelled on RunPod');
          } catch (cancelError) {
            // Cancel failed - maybe just completed
            logger.warn({ error: cancelError, mediaId: id }, 'RunPod cancel failed, checking status again');
            const newStatus = await runpodClient.getJobStatus(runpodJobId);
            if (newStatus.status === 'COMPLETED') {
              throw new Error('Job completed before cancellation');
            }
            // Cancel failed for other reason, but we'll mark as cancelled in DB anyway
            logger.error({ error: cancelError, mediaId: id }, 'RunPod cancel failed, marking as cancelled in DB');
          }
        }
      } catch (error) {
        // If error is "already completed", propagate it
        if (error instanceof Error && error.message.includes('already completed')) {
          throw error;
        }
        // Other errors - log and continue with DB cancellation
        logger.error({ error, mediaId: id }, 'Error checking/cancelling RunPod job');
      }
    }

    // Mark as cancelled in DB
    await db
      .update(media)
      .set({
        cancelledAt: new Date(),
        status: 'failed',
        error: 'Cancelled by user',
        updatedAt: new Date()
      })
      .where(eq(media.id, id));

    logger.info({ mediaId: id }, 'Job cancelled successfully');

    return { cancelled: true };
  }
}

export const generationsService = new GenerationsService();

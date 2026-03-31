import { and, eq } from 'drizzle-orm';
import { db } from '../config/database';
import { jobService } from '../jobs';
import { documentMedia, documents, media } from '../models/schema';
import type {
  EntityContext,
  FeaturedEntity,
  MentionedEntity,
} from '../types/generationSettings';
import { GENERATION_SETTINGS_SCHEMA_VERSION } from '../types/generationSettings';
import { notDeleted } from '../utils/db';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { activityService } from './activity.service';
import { graphService } from './graph/graph.service';
import {
  getImageProvider,
  getReferenceImageProvider,
} from './image-generation/factory';
import { mentionService } from './mentions/mention.service';
import { fetchEntityReferenceData } from './prompt-augmentation/entityReferences';
import type { EntityReferences } from './prompt-augmentation/promptBuilder';
import { redis } from './redis';
import { runpodClient } from './runpod/client';

export interface PromptEnhancement {
  enabled: boolean;
  charsBefore: number;
  charsAfter: number;
  useNarrativeContext: boolean;
  sceneTreatment: 'comprehensive' | 'focused' | 'selective-detail';
  selectiveDetailFocus?: string;
  strength: 'low' | 'medium' | 'high';
  entityReferences?: EntityReferences;
}

export interface GenerationRequest {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  negativePrompt?: string | null;
  guidanceScale?: number;
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

    // Validate dimensions against provider constraints
    const provider = await getImageProvider();
    if (!provider.validateDimensions(width, height)) {
      const constraints = provider.getSupportedDimensions();

      // Build helpful error message
      let errorMessage = `Dimensions ${width}x${height} not supported by ${provider.name} provider. `;

      if (Array.isArray(constraints)) {
        // Fixed dimensions (e.g., Gemini)
        errorMessage += `Supported sizes: ${constraints.map((s) => `${s.width}x${s.height}`).join(', ')}`;
      } else {
        // Range-based dimensions (e.g., local/runpod)
        const { min, max, step } = constraints;
        errorMessage += `Valid range: ${min}-${max}px, step: ${step}px`;
      }

      throw new Error(errorMessage);
    }

    let stylePreset: string | null = null;
    let stylePrompt: string | null = null;

    const [document] = request.documentId
      ? await db
          .select()
          .from(documents)
          .where(eq(documents.id, request.documentId))
          .limit(1)
      : [];

    if (document) {
      stylePreset = document.defaultStylePreset;
      stylePrompt = document.defaultStylePrompt;
    }

    // Determine initial status based on whether augmentation is enabled
    const initialStatus = request.promptEnhancement?.enabled
      ? 'augmenting'
      : 'queued';

    // Build entity context from character references and text mentions
    let entityContext: EntityContext | undefined;
    const selectedNodeIds =
      request.promptEnhancement?.entityReferences?.selectedNodeIds;

    if (selectedNodeIds?.length || request.documentId) {
      const featured: FeaturedEntity[] = [];
      const mentioned: MentionedEntity[] = [];

      // Build featured entities from explicitly selected character references
      if (selectedNodeIds?.length) {
        const nodePromises = selectedNodeIds.map(async (nodeId) => {
          const node = await graphService.getStoryNodeByIdInternal(nodeId);
          if (!node) return null;
          return {
            nodeId,
            name: node.name,
            type: node.type,
            usedReference: !!node.primaryMediaId,
            referenceMediaId: node.primaryMediaId || undefined,
          } as FeaturedEntity;
        });
        const nodes = await Promise.all(nodePromises);
        for (const n of nodes) {
          if (n) featured.push(n);
        }
      }

      // Build mentioned entities from text overlap
      if (
        request.documentId &&
        request.startChar !== undefined &&
        request.endChar !== undefined
      ) {
        const mentionedRaw = await mentionService.getMentionsInRange(
          request.documentId,
          request.startChar,
          request.endChar,
        );
        // Exclude entities already in featured
        const featuredIds = new Set(featured.map((f) => f.nodeId));
        for (const m of mentionedRaw) {
          if (!featuredIds.has(m.nodeId)) {
            mentioned.push({
              nodeId: m.nodeId,
              name: m.name,
              type: m.type,
              confidence: m.confidence,
            });
          }
        }
      }

      if (featured.length > 0 || mentioned.length > 0) {
        entityContext = {
          featured,
          mentioned,
          cursorPosition: request.startChar,
        };
      }
    }

    const [newMedia] = await db
      .insert(media)
      .values({
        userId,
        sourceType: 'generation',
        status: initialStatus,
        prompt: request.prompt,
        seed,
        width,
        height,
        stylePreset,
        stylePrompt,
        generationSettings: entityContext
          ? { type: 'inline', entityContext }
          : undefined,
        generationSettingsSchemaVersion: entityContext
          ? GENERATION_SETTINGS_SCHEMA_VERSION
          : undefined,
      })
      .returning();

    if (request.documentId) {
      let contextBefore: string | undefined = request.contextBefore;
      let contextAfter: string | undefined = request.contextAfter;

      if (
        !contextBefore &&
        !contextAfter &&
        request.startChar !== undefined &&
        request.endChar !== undefined
      ) {
        if (document) {
          const CONTEXT_LENGTH = 50;
          const content = document.content;

          const contextBeforeStart = Math.max(
            0,
            request.startChar - CONTEXT_LENGTH,
          );
          contextBefore = content.substring(
            contextBeforeStart,
            request.startChar,
          );

          const contextAfterEnd = Math.min(
            content.length,
            request.endChar + CONTEXT_LENGTH,
          );
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

    // Create activity for progress tracking
    try {
      await activityService.createFromMedia({
        mediaId: newMedia.id,
        userId,
        documentId: request.documentId,
        title: 'Generating image',
      });
    } catch (activityError) {
      logger.error(
        { error: activityError, mediaId: newMedia.id },
        'Failed to create activity for image generation',
      );
    }

    try {
      // Check if augmentation is enabled
      if (request.promptEnhancement?.enabled) {
        // Augmentation flow: Create prompt_augmentation job
        if (
          !request.documentId ||
          request.startChar === undefined ||
          request.endChar === undefined
        ) {
          throw new Error(
            'Document ID, startChar, and endChar are required for prompt augmentation',
          );
        }

        await jobService.create({
          type: 'prompt_augmentation',
          targetType: 'media',
          targetId: newMedia.id,
          userId,
          payload: {
            mediaId: newMedia.id,
            documentId: request.documentId,
            selectedText: request.sourceText || request.prompt,
            startChar: request.startChar,
            endChar: request.endChar,
            settings: request.promptEnhancement,
            stylePrompt: stylePrompt || '',
            negativePrompt: request.negativePrompt,
            guidanceScale: request.guidanceScale,
            seed,
            width,
            height,
          },
        });

        // Track augmentation for rate limiting
        const now = new Date();
        const todayUTC = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const dateStr = todayUTC.toISOString().split('T')[0];
        const augmentationKey = `user:${userId}:augmentations:${dateStr}`;
        await redis.zadd(augmentationKey, Date.now(), newMedia.id);
        await redis.expire(augmentationKey, 172800); // 48h TTL for cleanup
      } else {
        // Direct generation flow (no augmentation)
        const entityRefs = request.promptEnhancement?.entityReferences;
        const hasEntityRefs =
          entityRefs &&
          (entityRefs.useImages || entityRefs.useDescriptions) &&
          request.documentId;

        let enrichedPrompt = request.prompt;
        let referenceImages:
          | Awaited<ReturnType<typeof fetchEntityReferenceData>>['images']
          | undefined;

        if (hasEntityRefs && request.documentId) {
          const entityData = await fetchEntityReferenceData(
            request.documentId,
            userId,
            entityRefs,
            request.sourceText || request.prompt,
          );

          if (
            entityRefs.useDescriptions &&
            entityData.descriptions.length > 0
          ) {
            const descText = entityData.descriptions
              .map((d) => `${d.name}: ${d.description}`)
              .join('. ');
            enrichedPrompt = `${request.prompt}\n\nEntity details: ${descText}`;
          }

          if (entityRefs.useImages && entityData.images.length > 0) {
            referenceImages = entityData.images;
          }
        }

        const provider = referenceImages?.length
          ? getReferenceImageProvider()
          : await getImageProvider();

        await provider.submitJob({
          mediaId: newMedia.id,
          userId,
          prompt: enrichedPrompt,
          seed,
          width,
          height,
          referenceImages,
          ...(request.negativePrompt
            ? { negativePrompt: request.negativePrompt }
            : {}),
          ...(request.guidanceScale !== undefined
            ? { guidanceScale: request.guidanceScale }
            : {}),
        });

        // Track generation for rate limiting
        const now = new Date();
        const todayUTC = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const dateStr = todayUTC.toISOString().split('T')[0];
        const rateLimitKey = `user:${userId}:generations:${dateStr}`;
        await redis.zadd(rateLimitKey, Date.now(), newMedia.id);
        await redis.expire(rateLimitKey, 172800); // 48h TTL for cleanup
      }
    } catch (error) {
      logger.error(
        { error, mediaId: newMedia.id },
        'Failed to queue generation, marking as failed',
      );
      await db
        .update(media)
        .set({ status: 'failed', error: 'Failed to queue job' })
        .where(eq(media.id, newMedia.id));
      throw error;
    }

    logger.info(
      { userId, mediaId: newMedia.id, totalElapsed: Date.now() - startTime },
      '[TIMING] generationsService.create COMPLETE',
    );
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
          eq(media.sourceType, 'generation'),
          notDeleted(media.deletedAt),
        ),
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
          eq(media.sourceType, 'generation'),
          notDeleted(media.deletedAt),
        ),
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
      logger.info(
        { mediaId: id, status: job.status },
        'Job already finished, cannot cancel',
      );
      throw new Error(`Job already ${job.status}`);
    }

    // Cancel any pending queue-based jobs (Gemini, etc.)
    const pendingJobs = await jobService.getJobsForTarget('media', id, [
      'queued',
      'processing',
    ]);
    for (const pendingJob of pendingJobs) {
      await jobService.updateStatus(pendingJob.id, 'cancelled');
      logger.info(
        { mediaId: id, jobId: pendingJob.id },
        'Cancelled pending job',
      );
    }

    // RunPod mode: Check status with RunPod API first to avoid race conditions
    if (runpodClient.isEnabled()) {
      const runpodJobId = await redis.get(`runpod:job:${id}`);

      if (!runpodJobId) {
        // No RunPod job ID - maybe never submitted or Redis expired
        // Just mark as cancelled in DB
        logger.warn(
          { mediaId: id },
          'No RunPod job ID found, marking as cancelled in DB',
        );
        await db
          .update(media)
          .set({
            cancelledAt: new Date(),
            status: 'failed',
            error: 'Cancelled by user',
          })
          .where(eq(media.id, id));
        return { cancelled: true };
      }

      try {
        // Check current RunPod status
        const status = await runpodClient.getJobStatus(runpodJobId);

        // Already completed - show result instead of cancelling
        if (status.status === 'COMPLETED') {
          logger.info(
            { mediaId: id, runpodJobId },
            'Job completed before cancellation',
          );
          throw new Error('Job already completed');
        }

        // Try to cancel on RunPod
        if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
          try {
            await runpodClient.cancelJob(runpodJobId);
            logger.info(
              { mediaId: id, runpodJobId },
              'Job cancelled on RunPod',
            );
          } catch (cancelError) {
            // Cancel failed - maybe just completed
            logger.warn(
              { error: cancelError, mediaId: id },
              'RunPod cancel failed, checking status again',
            );
            const newStatus = await runpodClient.getJobStatus(runpodJobId);
            if (newStatus.status === 'COMPLETED') {
              throw new Error('Job completed before cancellation');
            }
            // Cancel failed for other reason, but we'll mark as cancelled in DB anyway
            logger.error(
              { error: cancelError, mediaId: id },
              'RunPod cancel failed, marking as cancelled in DB',
            );
          }
        }
      } catch (error) {
        // If error is "already completed", propagate it
        if (
          error instanceof Error &&
          error.message.includes('already completed')
        ) {
          throw error;
        }
        // Other errors - log and continue with DB cancellation
        logger.error(
          { error, mediaId: id },
          'Error checking/cancelling RunPod job',
        );
      }
    }

    // Mark as cancelled in DB
    await db
      .update(media)
      .set({
        cancelledAt: new Date(),
        status: 'failed',
        error: 'Cancelled by user',
        updatedAt: new Date(),
      })
      .where(eq(media.id, id));

    logger.info({ mediaId: id }, 'Job cancelled successfully');

    return { cancelled: true };
  }
}

export const generationsService = new GenerationsService();

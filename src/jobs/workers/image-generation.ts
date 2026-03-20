/**
 * Image generation worker.
 * Processes image generation jobs through the job queue for crash recovery.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { calculateImageCost } from '../../config/pricing.js';
import { media } from '../../models/schema.js';
import { activityService } from '../../services/activity.service.js';
import { imageUsageTracking } from '../../services/imageUsageTracking/index.js';
import { s3 } from '../../services/s3.js';
import { logger } from '../../utils/logger.js';
import { jobService } from '../service.js';
import type { Job, JobProgress, JobType } from '../types.js';
import { JobWorker } from '../worker.js';

const GENERATION_TIMEOUT_MS = 60_000;

// Gemini Imagen 3 supported dimensions
const SUPPORTED_DIMENSIONS: Array<[number, number]> = [
  [1024, 1024], // 1:1
  [1408, 768], // 16:9 landscape
  [768, 1408], // 9:16 portrait
  [1280, 896], // 4:3 landscape
  [896, 1280], // 3:4 portrait
];

export interface ImageGenerationPayload {
  mediaId: string;
  userId: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  stylePrompt?: string;
}

// Lazy-loaded Gemini client
let genAI: Awaited<ReturnType<typeof getGeminiClient>> | null = null;

async function getGeminiClient() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

async function ensureGenAI() {
  if (!genAI) {
    genAI = await getGeminiClient();
  }
  return genAI;
}

class ImageGenerationWorker extends JobWorker<
  ImageGenerationPayload,
  JobProgress
> {
  protected jobType: JobType = 'image_generation';

  constructor() {
    super('image-generation-worker');
  }

  protected async processJob(
    job: Job,
    payload: ImageGenerationPayload,
  ): Promise<void> {
    const { mediaId, userId, prompt, width, height } = payload;

    if (!mediaId || !prompt) {
      logger.error(
        { jobId: job.id, payload },
        'Image generation job missing required fields',
      );
      return;
    }

    logger.info(
      { jobId: job.id, mediaId, prompt: prompt.substring(0, 100) },
      'Processing image generation',
    );

    // Update media status to processing
    await db
      .update(media)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(media.id, mediaId));

    // Update activity to running
    const activity = await activityService.getByMediaId(mediaId);
    if (activity) {
      await activityService.updateStatus(activity.id, 'running');
      await activityService.updateProgress(activity.id, {
        stageName: 'Generating image',
      });
    } else {
      logger.warn(
        { mediaId, userId, jobId: job.id },
        'No activity found for media at job start',
      );
    }

    // Broadcast status update
    await jobService.create({
      type: 'media_status_update',
      targetType: 'media',
      targetId: mediaId,
      userId,
      payload: { mediaId, status: 'processing' },
    });

    // Track usage
    const { apiCostUsd } = calculateImageCost({ provider: 'gemini' });
    imageUsageTracking
      .recordImageUsage({
        userId,
        mediaId,
        provider: 'gemini',
        costUsd: apiCostUsd,
      })
      .catch((err) => logger.error({ err }, 'Image usage tracking failed'));

    try {
      // Map dimensions to nearest supported aspect ratio
      const [mappedWidth, mappedHeight] = this.mapToNearestDimensions(
        width,
        height,
      );

      logger.info(
        {
          mediaId,
          requestedDimensions: `${width}x${height}`,
          mappedDimensions: `${mappedWidth}x${mappedHeight}`,
        },
        'Generating image with Gemini Imagen',
      );

      // Generate image via Gemini Imagen API
      const aspectRatio = this.getAspectRatio(mappedWidth, mappedHeight);

      const client = await ensureGenAI();
      if (!client) {
        throw new Error('Image generation service unavailable');
      }

      const response = await Promise.race([
        client.models.generateImages({
          model: 'imagen-4.0-generate-001',
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Image generation timed out')),
            GENERATION_TIMEOUT_MS,
          ),
        ),
      ]);

      if (!response.generatedImages || response.generatedImages.length === 0) {
        throw new Error('Image generation failed - no images returned');
      }

      // Convert base64 to buffer
      const image = response.generatedImages[0].image;
      if (!image?.imageBytes) {
        throw new Error('Image generation failed - no image data');
      }
      const imageBuffer = Buffer.from(image.imageBytes, 'base64');

      // Upload to S3
      const s3Key = `users/${userId}/media/${mediaId}.png`;
      await s3.uploadBuffer(imageBuffer, s3Key, 'image/png');

      // Update DB to completed
      await db
        .update(media)
        .set({
          status: 'completed',
          s3Key,
          width: mappedWidth,
          height: mappedHeight,
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));

      // Broadcast completion
      await jobService.create({
        type: 'media_status_update',
        targetType: 'media',
        targetId: mediaId,
        userId,
        payload: { mediaId, status: 'completed', s3Key },
      });

      // Update activity to completed (re-lookup in case created after job started)
      const completedActivity =
        activity ?? (await activityService.getByMediaId(mediaId));
      if (completedActivity) {
        await activityService.updateStatus(completedActivity.id, 'completed');
      } else {
        logger.error(
          { mediaId, userId, jobId: job.id },
          'Activity not found - completion status not persisted',
        );
      }

      logger.info(
        { jobId: job.id, mediaId, s3Key },
        'Image generation completed',
      );
    } catch (error) {
      // Update media status to failed before re-throwing
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      await db
        .update(media)
        .set({
          status: 'failed',
          error: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));

      // Broadcast failure
      await jobService.create({
        type: 'media_status_update',
        targetType: 'media',
        targetId: mediaId,
        userId,
        payload: {
          mediaId,
          status: 'failed',
          error: errorMessage,
        },
      });

      // Update activity to failed (re-lookup in case created after job started)
      const failedActivity =
        activity ?? (await activityService.getByMediaId(mediaId));
      if (failedActivity) {
        await activityService.updateStatus(failedActivity.id, 'failed', {
          errorMessage,
        });
      } else {
        logger.error(
          { mediaId, userId, jobId: job.id },
          'Activity not found - failure status not persisted',
        );
      }

      // Re-throw to let base class handle job status update
      throw error;
    }
  }

  /**
   * Map requested dimensions to nearest supported Gemini Imagen dimensions
   */
  private mapToNearestDimensions(
    width: number,
    height: number,
  ): [number, number] {
    const exactMatch = SUPPORTED_DIMENSIONS.find(
      ([w, h]) => w === width && h === height,
    );
    if (exactMatch) {
      return exactMatch;
    }

    const requestedRatio = width / height;
    let nearest = SUPPORTED_DIMENSIONS[0];
    let minDiff = Math.abs(nearest[0] / nearest[1] - requestedRatio);

    for (const dims of SUPPORTED_DIMENSIONS) {
      const ratio = dims[0] / dims[1];
      const diff = Math.abs(ratio - requestedRatio);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = dims;
      }
    }

    return nearest;
  }

  /**
   * Get aspect ratio string for Gemini API
   */
  private getAspectRatio(width: number, height: number): string {
    const ratio = width / height;

    if (Math.abs(ratio - 1) < 0.01) return '1:1';
    if (Math.abs(ratio - 1.833) < 0.01) return '16:9';
    if (Math.abs(ratio - 0.545) < 0.01) return '9:16';
    if (Math.abs(ratio - 1.429) < 0.01) return '4:3';
    if (Math.abs(ratio - 0.7) < 0.01) return '3:4';

    logger.warn(
      { width, height, ratio },
      'Unknown aspect ratio, defaulting to 1:1',
    );
    return '1:1';
  }
}

export const imageGenerationWorker = new ImageGenerationWorker();

import { eq } from 'drizzle-orm';
import { db } from '../../../config/database.js';
import {
  getModelIdForProvider,
  getSupportedDimensionsForProvider,
  mapToNearestSupportedDimensions,
  validateDimensionsForModel,
} from '../../../config/models.js';
import { calculateImageCost } from '../../../config/pricing.js';
import { jobService } from '../../../jobs/index.js';
import { media } from '../../../models/schema.js';
import { logger } from '../../../utils/logger.js';
import { imageUsageTracking } from '../../imageUsageTracking/index.js';
import { s3 } from '../../s3.js';
import type { ImageGenerationProvider } from '../provider.interface.js';
import type { DimensionWhitelist, GenerationInput } from '../types.js';

// Dynamic import: @google/genai is ESM-only
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

class GeminiProImageProvider implements ImageGenerationProvider {
  readonly name = 'gemini-pro-image' as const;

  isEnabled(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  getCostEstimate() {
    return calculateImageCost({ provider: 'gemini-pro-image' });
  }

  async submitJob(input: GenerationInput): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('Gemini Pro Image provider is not enabled');
    }

    // Fire and forget - process asynchronously
    this.processGeneration(input).catch((error) => {
      logger.error(
        { error, mediaId: input.mediaId },
        'Gemini Pro Image generation failed',
      );
    });
  }

  private async processGeneration(input: GenerationInput): Promise<void> {
    try {
      // Update status to processing
      await db
        .update(media)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(media.id, input.mediaId));

      // Broadcast status update via job system
      await jobService.create({
        type: 'media_status_update',
        targetType: 'media',
        targetId: input.mediaId,
        userId: input.userId,
        payload: { mediaId: input.mediaId, status: 'processing' },
      });

      const { apiCostUsd } = this.getCostEstimate();
      imageUsageTracking
        .recordImageUsage({
          userId: input.userId,
          mediaId: input.mediaId,
          provider: 'gemini-pro-image',
          costUsd: apiCostUsd,
        })
        .catch((err) => logger.error({ err }, 'Image usage tracking failed'));

      // Map dimensions to nearest supported
      const [width, height] = this.mapToNearestDimensions(
        input.width,
        input.height,
      );

      logger.info(
        {
          mediaId: input.mediaId,
          prompt: input.prompt,
          requestedDimensions: `${input.width}x${input.height}`,
          mappedDimensions: `${width}x${height}`,
          referenceImageCount: input.referenceImages?.length || 0,
        },
        'Generating image with Gemini Pro Image',
      );

      const client = await ensureGenAI();
      if (!client) {
        throw new Error('Gemini client not initialized');
      }

      // Build contents array with prompt and reference images
      const contents: Array<
        string | { inlineData: { mimeType: string; data: string } }
      > = [input.prompt];

      if (input.referenceImages && input.referenceImages.length > 0) {
        logger.info(
          {
            mediaId: input.mediaId,
            referenceCount: input.referenceImages.length,
            characterNames: input.referenceImages.map((r) => r.nodeName),
          },
          'Including character reference images',
        );

        for (const refImage of input.referenceImages) {
          contents.push({
            inlineData: {
              mimeType: refImage.mimeType || 'image/jpeg',
              data: refImage.buffer.toString('base64'),
            },
          });
        }
      }

      // Call Gemini Pro Image API
      const modelId = getModelIdForProvider(this.name);
      const response = await client.models.generateContent({
        model: modelId,
        contents,
        config: {
          responseModalities: ['image', 'text'],
        },
      });

      // Extract image from response
      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) {
        throw new Error('No candidates in Gemini Pro Image response');
      }

      const parts = candidates[0].content?.parts;
      if (!parts) {
        throw new Error('No parts in Gemini Pro Image response');
      }

      // Find the image part
      let imageData: string | undefined;
      let imageMimeType = 'image/png';

      for (const part of parts) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          imageMimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }

      if (!imageData) {
        throw new Error('No image data in Gemini Pro Image response');
      }

      const imageBuffer = Buffer.from(imageData, 'base64');

      // Upload to S3
      const ext = imageMimeType.includes('jpeg') ? 'jpg' : 'png';
      const s3Key = `users/${input.userId}/media/${input.mediaId}.${ext}`;
      await s3.uploadBuffer(imageBuffer, s3Key, imageMimeType);

      // Update DB to completed
      await db
        .update(media)
        .set({
          status: 'completed',
          s3Key,
          width,
          height,
          updatedAt: new Date(),
        })
        .where(eq(media.id, input.mediaId));

      // Broadcast completion via job system
      await jobService.create({
        type: 'media_status_update',
        targetType: 'media',
        targetId: input.mediaId,
        userId: input.userId,
        payload: { mediaId: input.mediaId, status: 'completed', s3Key },
      });

      logger.info(
        { mediaId: input.mediaId, s3Key },
        'Gemini Pro Image generation completed',
      );
    } catch (error: unknown) {
      logger.error(
        { error, mediaId: input.mediaId },
        'Gemini Pro Image generation failed',
      );

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Update DB to failed
      await db
        .update(media)
        .set({
          status: 'failed',
          error: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(media.id, input.mediaId));

      // Broadcast failure via job system
      await jobService.create({
        type: 'media_status_update',
        targetType: 'media',
        targetId: input.mediaId,
        userId: input.userId,
        payload: {
          mediaId: input.mediaId,
          status: 'failed',
          error: errorMessage,
        },
      });
    }
  }

  getSupportedDimensions(): DimensionWhitelist {
    return getSupportedDimensionsForProvider(this.name);
  }

  validateDimensions(width: number, height: number): boolean {
    const modelId = getModelIdForProvider(this.name);
    return validateDimensionsForModel(width, height, modelId);
  }

  supportsReferenceImages(): boolean {
    return true;
  }

  private mapToNearestDimensions(
    width: number,
    height: number,
  ): [number, number] {
    const modelId = getModelIdForProvider(this.name);
    const result = mapToNearestSupportedDimensions(width, height, modelId);
    if (result[0] !== width || result[1] !== height) {
      logger.warn(
        {
          requested: `${width}x${height}`,
          mapped: `${result[0]}x${result[1]}`,
        },
        'Mapped to nearest supported Gemini Pro Image dimensions',
      );
    }
    return result;
  }
}

export const geminiProImageProvider = new GeminiProImageProvider();

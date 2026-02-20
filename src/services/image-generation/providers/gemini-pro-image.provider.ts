import { eq } from 'drizzle-orm';
import { db } from '../../../config/database.js';
import { media } from '../../../models/schema.js';
import { logger } from '../../../utils/logger.js';
import { redisStreams } from '../../redis-streams.js';
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

// Gemini Pro Image supported dimensions (same as Imagen for consistency)
const SUPPORTED_DIMENSIONS: Array<[number, number]> = [
  [1024, 1024], // 1:1
  [1408, 768], // 16:9 landscape
  [768, 1408], // 9:16 portrait
  [1280, 896], // 4:3 landscape
  [896, 1280], // 3:4 portrait
];

class GeminiProImageProvider implements ImageGenerationProvider {
  readonly name = 'gemini-pro-image' as const;

  isEnabled(): boolean {
    return !!process.env.GEMINI_API_KEY;
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

      // Broadcast status update
      await redisStreams.add('job:status:stream', {
        mediaId: input.mediaId,
        status: 'processing',
      });

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
      const contents: any[] = [input.prompt];

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
      const response = await client.models.generateContent({
        model: 'gemini-3-pro-image-preview',
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

      // Broadcast completion
      await redisStreams.add('job:status:stream', {
        mediaId: input.mediaId,
        status: 'completed',
        s3Key,
      });

      logger.info(
        { mediaId: input.mediaId, s3Key },
        'Gemini Pro Image generation completed',
      );
    } catch (error: any) {
      logger.error(
        { error, mediaId: input.mediaId },
        'Gemini Pro Image generation failed',
      );

      const errorMessage = error?.message || 'Unknown error';

      // Update DB to failed
      await db
        .update(media)
        .set({
          status: 'failed',
          error: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(media.id, input.mediaId));

      // Broadcast failure
      await redisStreams.add('job:status:stream', {
        mediaId: input.mediaId,
        status: 'failed',
        error: errorMessage,
      });
    }
  }

  getSupportedDimensions(): DimensionWhitelist {
    return SUPPORTED_DIMENSIONS.map(([width, height]) => ({ width, height }));
  }

  validateDimensions(width: number, height: number): boolean {
    const requestedRatio = width / height;
    return SUPPORTED_DIMENSIONS.some(([w, h]) => {
      const supportedRatio = w / h;
      return Math.abs(supportedRatio - requestedRatio) < 0.1;
    });
  }

  supportsReferenceImages(): boolean {
    return true;
  }

  /**
   * Map requested dimensions to nearest supported dimensions
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

    logger.warn(
      {
        requested: `${width}x${height}`,
        mapped: `${nearest[0]}x${nearest[1]}`,
      },
      'Mapped to nearest supported Gemini Pro Image dimensions',
    );

    return nearest;
  }
}

export const geminiProImageProvider = new GeminiProImageProvider();

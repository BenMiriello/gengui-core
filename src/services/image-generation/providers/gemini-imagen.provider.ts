import { env } from '../../../config/env.js';
import {
  getModelIdForProvider,
  getSupportedDimensionsForProvider,
  validateDimensionsForModel,
} from '../../../config/models.js';
import { calculateImageCost } from '../../../config/pricing.js';
import { jobService } from '../../../jobs/index.js';
import { logger } from '../../../utils/logger.js';
import type { ImageGenerationProvider } from '../provider.interface.js';
import type { DimensionWhitelist, GenerationInput } from '../types.js';

class GeminiImagenProvider implements ImageGenerationProvider {
  readonly name = 'gemini' as const;

  isEnabled(): boolean {
    return (
      env.IMAGE_INFERENCE_PROVIDER === 'gemini' && !!process.env.GEMINI_API_KEY
    );
  }

  getCostEstimate() {
    return calculateImageCost({ provider: 'gemini' });
  }

  async submitJob(input: GenerationInput): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('Gemini Imagen provider is not enabled');
    }

    // Create a job in the queue - worker will process it
    const job = await jobService.create({
      type: 'image_generation',
      targetType: 'media',
      targetId: input.mediaId,
      userId: input.userId,
      payload: {
        mediaId: input.mediaId,
        userId: input.userId,
        prompt: input.prompt,
        seed: input.seed,
        width: input.width,
        height: input.height,
        stylePrompt: input.stylePrompt,
        negativePrompt: input.negativePrompt,
        guidanceScale: input.guidanceScale,
      },
    });

    if (!job) {
      throw new Error('Failed to create image generation job');
    }

    logger.info(
      { jobId: job.id, mediaId: input.mediaId },
      'Image generation job queued',
    );
  }

  getSupportedDimensions(): DimensionWhitelist {
    return getSupportedDimensionsForProvider(this.name);
  }

  validateDimensions(width: number, height: number): boolean {
    const modelId = getModelIdForProvider(this.name);
    return validateDimensionsForModel(width, height, modelId);
  }

  supportsReferenceImages(): boolean {
    return false;
  }
}

export const geminiImagenProvider = new GeminiImagenProvider();

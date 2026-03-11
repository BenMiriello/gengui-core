import { env } from '../../../config/env.js';
import { calculateImageCost } from '../../../config/pricing.js';
import { jobService } from '../../../jobs/index.js';
import { logger } from '../../../utils/logger.js';
import type { ImageGenerationProvider } from '../provider.interface.js';
import type { DimensionWhitelist, GenerationInput } from '../types.js';

// Gemini Imagen 3 supported dimensions
const SUPPORTED_DIMENSIONS: Array<[number, number]> = [
  [1024, 1024], // 1:1
  [1408, 768], // 16:9 landscape
  [768, 1408], // 9:16 portrait
  [1280, 896], // 4:3 landscape
  [896, 1280], // 3:4 portrait
];

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
    return SUPPORTED_DIMENSIONS.map(([width, height]) => ({ width, height }));
  }

  validateDimensions(width: number, height: number): boolean {
    // Allow dimensions with compatible aspect ratios, not just exact matches
    // This allows the mapping logic to convert to nearest supported size
    const requestedRatio = width / height;
    return SUPPORTED_DIMENSIONS.some(([w, h]) => {
      const supportedRatio = w / h;
      return Math.abs(supportedRatio - requestedRatio) < 0.1;
    });
  }

  supportsReferenceImages(): boolean {
    return false;
  }
}

export const geminiImagenProvider = new GeminiImagenProvider();

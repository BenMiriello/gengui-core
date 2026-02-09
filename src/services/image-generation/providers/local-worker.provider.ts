import { logger } from '../../../utils/logger.js';
import { redisStreams } from '../../redis-streams.js';
import type { ImageGenerationProvider } from '../provider.interface.js';
import type { DimensionWhitelist, GenerationInput } from '../types.js';

class LocalWorkerProvider implements ImageGenerationProvider {
  readonly name = 'local' as const;

  isEnabled(): boolean {
    // Local worker is always available (default option)
    return true;
  }

  async submitJob(input: GenerationInput): Promise<void> {
    await redisStreams.add('generation:stream', {
      userId: input.userId,
      mediaId: input.mediaId,
      prompt: input.prompt,
      seed: input.seed.toString(),
      width: input.width.toString(),
      height: input.height.toString(),
      status: 'queued',
    });

    logger.info(
      { mediaId: input.mediaId, prompt: input.prompt },
      'Generation queued in Redis stream for local worker'
    );
  }

  getSupportedDimensions(): DimensionWhitelist {
    return { min: 256, max: 2048, step: 64 };
  }

  validateDimensions(width: number, height: number): boolean {
    const constraints = this.getSupportedDimensions() as { min: number; max: number; step: number };

    if (width < constraints.min || width > constraints.max) return false;
    if (height < constraints.min || height > constraints.max) return false;
    if (width % constraints.step !== 0) return false;
    if (height % constraints.step !== 0) return false;

    return true;
  }

  supportsReferenceImages(): boolean {
    return false;
  }
}

export const localWorkerProvider = new LocalWorkerProvider();

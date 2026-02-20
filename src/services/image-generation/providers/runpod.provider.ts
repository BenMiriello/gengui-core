import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { redis } from '../../redis.js';
import { runpodClient } from '../../runpod/client.js';
import { RUNPOD_CONSTANTS } from '../../runpod/constants.js';
import type { ImageGenerationProvider } from '../provider.interface.js';
import type { DimensionWhitelist, GenerationInput } from '../types.js';

class RunPodProvider implements ImageGenerationProvider {
  readonly name = 'runpod' as const;

  isEnabled(): boolean {
    return (
      env.IMAGE_INFERENCE_PROVIDER === 'runpod' && runpodClient.isEnabled()
    );
  }

  async submitJob(input: GenerationInput): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('RunPod provider is not enabled');
    }

    const runpodJobId = await runpodClient.submitJob(
      {
        mediaId: input.mediaId,
        userId: input.userId,
        prompt: input.prompt,
        seed: input.seed.toString(),
        width: input.width.toString(),
        height: input.height.toString(),
      },
      {
        executionTimeout: RUNPOD_CONSTANTS.EXECUTION_TIMEOUT_MS,
      },
    );

    // Store RunPod job ID and submission timestamp in Redis for reconciliation
    await redis.set(
      `runpod:job:${input.mediaId}`,
      runpodJobId,
      RUNPOD_CONSTANTS.REDIS_JOB_TTL_SECONDS,
    );
    await redis.set(
      `runpod:job:${input.mediaId}:submitted`,
      Date.now().toString(),
      RUNPOD_CONSTANTS.REDIS_JOB_TTL_SECONDS,
    );

    logger.info(
      { mediaId: input.mediaId, runpodJobId, prompt: input.prompt },
      'Generation submitted to RunPod',
    );
  }

  getSupportedDimensions(): DimensionWhitelist {
    // RunPod uses same constraints as local worker (Z-Image-Turbo model)
    return { min: 256, max: 2048, step: 64 };
  }

  validateDimensions(width: number, height: number): boolean {
    const constraints = this.getSupportedDimensions() as {
      min: number;
      max: number;
      step: number;
    };

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

export const runpodProvider = new RunPodProvider();

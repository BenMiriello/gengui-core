import { env } from '../../config/env.js';
import { getGrowthBook } from '../growthbook.js';
import type { ImageGenerationProvider } from './provider.interface.js';
import { geminiImagenProvider } from './providers/gemini-imagen.provider.js';
import { geminiProImageProvider } from './providers/gemini-pro-image.provider.js';
import { localWorkerProvider } from './providers/local-worker.provider.js';
import { runpodProvider } from './providers/runpod.provider.js';

let cachedProvider: ImageGenerationProvider | null = null;
let cachedProviderName: string | null = null;

/**
 * Get the configured image generation provider
 * Reads from GrowthBook flag 'image_provider', falls back to env var
 */
export async function getImageProvider(): Promise<ImageGenerationProvider> {
  const gb = await getGrowthBook();
  const providerName = gb.getFeatureValue(
    'image_provider',
    env.IMAGE_INFERENCE_PROVIDER,
  );

  // Return cached if provider hasn't changed
  if (cachedProvider && cachedProviderName === providerName) {
    return cachedProvider;
  }

  cachedProviderName = providerName;

  switch (providerName) {
    case 'local':
      cachedProvider = localWorkerProvider;
      break;
    case 'runpod':
      cachedProvider = runpodProvider;
      break;
    case 'gemini-pro-image':
      cachedProvider = geminiProImageProvider;
      break;
    default:
      cachedProvider = geminiImagenProvider;
      break;
  }

  return cachedProvider;
}

/**
 * Get the provider that supports reference images
 * Used when character references are included in generation
 */
export function getReferenceImageProvider(): ImageGenerationProvider {
  return geminiProImageProvider;
}

/**
 * Reset the cached provider (useful for testing)
 */
export function resetProviderCache(): void {
  cachedProvider = null;
  cachedProviderName = null;
}

/**
 * Get the current provider name (from GrowthBook or env)
 */
export async function getImageProviderName(): Promise<string> {
  const gb = await getGrowthBook();
  return gb.getFeatureValue('image_provider', env.IMAGE_INFERENCE_PROVIDER);
}

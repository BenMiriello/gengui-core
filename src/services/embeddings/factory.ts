import {
  getCurrentAnalysisVersion,
  getVersionConfig,
} from '../../config/analysis-versions';
import type { EmbeddingProvider } from './provider.interface';

const providerCache = new Map<string, EmbeddingProvider>();

function getProviderForModel(model: string): EmbeddingProvider {
  const cached = providerCache.get(model);
  if (cached) return cached;

  let provider: EmbeddingProvider;

  switch (model) {
    case 'openai-3-small': {
      const {
        openaiEmbeddingProvider,
      } = require('./providers/openai.provider');
      provider = openaiEmbeddingProvider;
      break;
    }
    case 'voyage-4-lite': {
      const {
        voyageEmbeddingProvider,
      } = require('./providers/voyage.provider');
      provider = voyageEmbeddingProvider;
      break;
    }
    default:
      throw new Error(`Unknown embedding model: ${model}`);
  }

  providerCache.set(model, provider);
  return provider;
}

/**
 * Get embedding provider for a specific model.
 * If no model specified, uses the current default version's model.
 */
export function getEmbeddingProvider(model?: string): EmbeddingProvider {
  const targetModel =
    model ?? getVersionConfig(getCurrentAnalysisVersion()).embeddingModel;
  return getProviderForModel(targetModel);
}

/**
 * Get embedding provider for a specific analysis version.
 */
export function getEmbeddingProviderForVersion(
  version: string,
): EmbeddingProvider {
  const versionConfig = getVersionConfig(version);
  return getProviderForModel(versionConfig.embeddingModel);
}

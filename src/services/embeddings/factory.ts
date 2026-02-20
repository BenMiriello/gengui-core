import type { EmbeddingProvider } from './provider.interface';

let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = process.env.EMBEDDING_PROVIDER || 'openai';

  switch (providerName) {
    default: {
      const {
        openaiEmbeddingProvider,
      } = require('./providers/openai.provider');
      cachedProvider = openaiEmbeddingProvider;
      break;
    }
  }

  return cachedProvider!;
}

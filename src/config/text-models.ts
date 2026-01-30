export const EMBEDDING_MODELS = {
  'text-embedding-3-small': {
    provider: 'openai',
    dimensions: 1536,
    maxTokens: 8191,
    costPer1MTokens: 0.02,
  },
} as const;

export type EmbeddingModelId = keyof typeof EMBEDDING_MODELS;

export const EMBEDDING_MODELS = {
  'text-embedding-3-small': {
    provider: 'openai',
    dimensions: 1536,
    maxTokens: 8191,
    costPer1MTokens: 0.02,
  },
} as const;

export type EmbeddingModelId = keyof typeof EMBEDDING_MODELS;

/**
 * Text generation model configurations.
 * Used for dynamic context budget calculations.
 */
export interface TextModelConfig {
  provider: 'gemini' | 'openai' | 'anthropic';
  maxTokens: number;
  /** Characters per token estimate (for budget calculations) */
  charsPerToken: number;
  /** Target utilization of context window (0-1) */
  targetUtilization: number;
  costPer1MInputTokens?: number;
  costPer1MOutputTokens?: number;
}

export const TEXT_MODELS: Record<string, TextModelConfig> = {
  'gemini-2.5-flash': {
    provider: 'gemini',
    maxTokens: 1048576,
    charsPerToken: 3.3,
    targetUtilization: 0.8,
    costPer1MInputTokens: 0.075,
    costPer1MOutputTokens: 0.3,
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    maxTokens: 1048576,
    charsPerToken: 3.3,
    targetUtilization: 0.8,
    costPer1MInputTokens: 1.25,
    costPer1MOutputTokens: 10.0,
  },
  'gemini-2.0-flash': {
    provider: 'gemini',
    maxTokens: 1048576,
    charsPerToken: 3.3,
    targetUtilization: 0.8,
    costPer1MInputTokens: 0.1,
    costPer1MOutputTokens: 0.4,
  },
} as const;

export type TextModelId = keyof typeof TEXT_MODELS;

/**
 * Get model config by ID, with fallback to gemini-2.5-flash defaults.
 */
export function getTextModelConfig(modelId: string): TextModelConfig {
  return (
    TEXT_MODELS[modelId] ?? {
      provider: 'gemini',
      maxTokens: 1048576,
      charsPerToken: 3.3,
      targetUtilization: 0.8,
    }
  );
}

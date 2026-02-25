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
  /** Maximum context window (input + output combined) */
  maxTokens: number;
  /** Maximum output tokens the model can generate */
  maxOutputTokens: number;
  /** Characters per token estimate (for budget calculations) */
  charsPerToken: number;
  /** Optional override for context window targeting. If not set, uses system-wide default. */
  targetUtilization?: number;
  /** Optional override for output capacity targeting. If not set, uses system-wide default. */
  outputUtilization?: number;
  costPer1MInputTokens?: number;
  costPer1MOutputTokens?: number;
}

export const TEXT_MODELS: Record<string, TextModelConfig> = {
  'gemini-2.5-flash': {
    provider: 'gemini',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    charsPerToken: 3.3,
    costPer1MInputTokens: 0.075,
    costPer1MOutputTokens: 0.3,
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    charsPerToken: 3.3,
    costPer1MInputTokens: 1.25,
    costPer1MOutputTokens: 10.0,
  },
  'gemini-2.0-flash': {
    provider: 'gemini',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    charsPerToken: 3.3,
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
      maxOutputTokens: 65536,
      charsPerToken: 3.3,
    }
  );
}

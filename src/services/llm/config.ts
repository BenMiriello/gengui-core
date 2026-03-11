/**
 * Default configurations for LLM client.
 * These defaults are applied to ALL LLM calls unless explicitly overridden.
 */

export const DEFAULT_CONFIG = {
  model: 'gemini-2.5-flash' as const,
  maxRetries: 5,
  retryDelays: [1000, 2000, 4000, 8000, 16000],
  timeout: 120000,
  thinkingConfig: { thinkingBudget: 0 },
} as const;

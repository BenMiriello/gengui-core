/**
 * Default configurations for LLM client.
 * These defaults are applied to ALL LLM calls unless explicitly overridden.
 */

export const DEFAULT_CONFIG = {
  model: 'gemini-2.5-flash' as const,
  maxRetries: 3,
  retryDelays: [1000, 2000, 4000],
  timeout: 120000,
  thinkingConfig: { thinkingBudget: 0 },
} as const;

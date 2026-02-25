/**
 * Configuration for summary generation and selection.
 * Centralized to avoid magic numbers throughout codebase.
 */

export const CONFIG = {
  // Summary generation
  targetSummaryWords: 100,
  tokensPerSummary: 120, // 100 words + formatting overhead (~20% margin)

  // Input/output validation
  maxSegmentChars: 10000,   // ~2500 tokens, prevents embedding model overflow
  maxSummaryChars: 1000,    // ~250 tokens, safety margin for 100-word target

  // Retry logic for LLM failures
  maxRetries: 3,
  baseBackoffMs: 1000, // Exponential: 1s, 2s, 4s

  // Concurrency limits (prevent memory pressure)
  summaryConcurrency: 10, // Max parallel summary generation calls

  // Selection algorithm weights (must sum to 1.0)
  priorityWeights: {
    recency: 0.4,    // Recent segments most relevant
    early: 0.3,      // Early segments provide setup/context
    middle: 0.3,     // Middle segments with exponential decay
  },

  // Budget allocation
  summaryBudgetPct: 0.2, // Use 20% of context budget for summaries

  // Models
  summaryModel: 'gemini-2.5-flash',         // Fast, cheap for segment summaries
  documentSummaryModel: 'gemini-2.5-flash', // Same model for document summaries
} as const;

// Type-safe access
export type SummaryConfig = typeof CONFIG;

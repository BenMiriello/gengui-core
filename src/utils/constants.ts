/**
 * Shared constants for the application.
 * Centralizes magic numbers and configuration values.
 */

/**
 * Progressive update configuration.
 * Per TDD 2026-02-21 Section 10: Edit chain tracking with forced regeneration.
 */
export const EDIT_CHAIN_CONFIG = {
  /**
   * Maximum number of progressive edits before forcing full regeneration.
   * Research shows drift accumulates after ~10 edits.
   */
  maxLength: 10,

  /**
   * Maximum depth of delta chain for version storage.
   * Beyond this, store a new full snapshot.
   */
  maxDeltaChainDepth: 20,
} as const;

/**
 * LLM batch processing configuration.
 */
export const BATCH_CONFIG = {
  /**
   * Default number of entities per description generation batch.
   */
  descriptionBatchSize: 15,

  /**
   * Minimum sentences for extractive fallback summary.
   */
  extractiveFallbackSentences: 5,

  /**
   * Maximum characters for extractive fallback when no sentences found.
   */
  extractiveFallbackChars: 500,
} as const;

/**
 * Conflict detection configuration.
 * Per TDD 2026-02-22 extraction-quality.md.
 */
export const CONFLICT_CONFIG = {
  /**
   * Cosine similarity threshold below which facets are considered potentially conflicting.
   * Lower similarity = more different = more likely to conflict.
   */
  similarityThreshold: 0.5,

  /**
   * Minimum number of changed lines to warrant a summary update.
   */
  minChangesForUpdate: 3,
} as const;

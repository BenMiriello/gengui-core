/**
 * Prompt management types.
 * Designed for future A/B testing and versioning capabilities.
 */

export interface PromptDefinition<TInput = unknown> {
  /** Unique identifier for this prompt (used for tracking/analytics) */
  id: string;

  /** Semantic version: MAJOR.MINOR.PATCH */
  version: number;

  /** Target model identifier */
  model: string;

  /** Human-readable description of what this prompt does */
  description: string;

  /** Function that builds the prompt string from input */
  build: (input: TInput) => string;
}

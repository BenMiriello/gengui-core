import type { GenerationInput, DimensionWhitelist } from './types.js';

export interface ImageGenerationProvider {
  readonly name: 'local' | 'runpod' | 'gemini';

  /**
   * Check if this provider is enabled and configured
   */
  isEnabled(): boolean;

  /**
   * Submit a generation job to this provider
   */
  submitJob(input: GenerationInput): Promise<void>;

  /**
   * Get the supported dimensions for this provider
   */
  getSupportedDimensions(): DimensionWhitelist;

  /**
   * Validate if the given dimensions are supported by this provider
   */
  validateDimensions(width: number, height: number): boolean;
}

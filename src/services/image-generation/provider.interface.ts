import type { DimensionWhitelist, GenerationInput } from './types.js';

export interface ImageGenerationProvider {
  readonly name: 'local' | 'runpod' | 'gemini' | 'gemini-pro-image';

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

  /**
   * Check if this provider supports reference images for character consistency
   */
  supportsReferenceImages(): boolean;
}

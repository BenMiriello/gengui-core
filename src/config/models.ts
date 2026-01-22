/**
 * Centralized image model configuration.
 * Model capabilities, dimension constraints, and provider associations.
 */

export type ImageProvider = 'local' | 'runpod' | 'gemini';

export interface ImageModelConfig {
  provider: ImageProvider;
  supportsReferenceImages: boolean;
  dimensions:
    | { type: 'whitelist'; values: Array<{ width: number; height: number }> }
    | { type: 'range'; min: number; max: number; step: number };
}

export const IMAGE_MODELS = {
  'imagen-4.0-generate-001': {
    provider: 'gemini',
    supportsReferenceImages: false,
    dimensions: {
      type: 'whitelist',
      values: [
        { width: 1024, height: 1024 },
        { width: 896, height: 1280 },
        { width: 1280, height: 896 },
        { width: 768, height: 1408 },
        { width: 1408, height: 768 },
      ],
    },
  },
  'gemini-2.0-flash-preview-image-generation': {
    provider: 'gemini',
    supportsReferenceImages: true,
    dimensions: {
      type: 'whitelist',
      values: [
        { width: 1024, height: 1024 },
        { width: 896, height: 1280 },
        { width: 1280, height: 896 },
        { width: 768, height: 1408 },
        { width: 1408, height: 768 },
      ],
    },
  },
  'z-image-turbo': {
    provider: 'local',
    supportsReferenceImages: false,
    dimensions: { type: 'range', min: 256, max: 2048, step: 64 },
  },
} as const satisfies Record<string, ImageModelConfig>;

export type ImageModelId = keyof typeof IMAGE_MODELS;

/**
 * Map provider names (from factory) to model IDs.
 * This bridges the gap between env-configured providers and model configs.
 */
export const PROVIDER_TO_MODEL: Record<string, ImageModelId> = {
  local: 'z-image-turbo',
  runpod: 'z-image-turbo',
  gemini: 'imagen-4.0-generate-001',
  'gemini-pro-image': 'gemini-2.0-flash-preview-image-generation',
};

export function getModelIdForProvider(providerName: string): ImageModelId {
  return PROVIDER_TO_MODEL[providerName] || 'imagen-4.0-generate-001';
}

// Target ratios for simple AR names
const TARGET_RATIOS = {
  portrait: 3 / 4,
  square: 1,
  landscape: 4 / 3,
} as const;

// Target base size (will be adjusted to match model constraints)
const TARGET_BASE = 1024;

export type SimpleAspectRatio = keyof typeof TARGET_RATIOS;

/**
 * Get dimensions for a simple AR, matched to model's supported dimensions.
 * - Whitelist: finds closest matching AR from model's supported values
 * - Range: uses exact target dimensions (snapped to step)
 */
export function getDimensionsForAspectRatio(
  ar: SimpleAspectRatio,
  modelId: ImageModelId
): { width: number; height: number } {
  const model = IMAGE_MODELS[modelId];
  const targetRatio = TARGET_RATIOS[ar];

  if (model.dimensions.type === 'range') {
    const { min, max, step } = model.dimensions;
    let width: number, height: number;

    if (targetRatio >= 1) {
      width = TARGET_BASE;
      height = Math.round(TARGET_BASE / targetRatio);
    } else {
      height = TARGET_BASE;
      width = Math.round(TARGET_BASE * targetRatio);
    }

    // Snap to step and clamp to range
    width = Math.min(max, Math.max(min, Math.round(width / step) * step));
    height = Math.min(max, Math.max(min, Math.round(height / step) * step));

    return { width, height };
  }

  // Whitelist: find closest AR match
  const values = model.dimensions.values;
  let closestWidth: number = values[0].width;
  let closestHeight: number = values[0].height;
  let minDiff = Math.abs(closestWidth / closestHeight - targetRatio);

  for (const dims of values) {
    const ratio = dims.width / dims.height;
    const diff = Math.abs(ratio - targetRatio);
    if (diff < minDiff) {
      minDiff = diff;
      closestWidth = dims.width;
      closestHeight = dims.height;
    }
  }

  return { width: closestWidth, height: closestHeight };
}

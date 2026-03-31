/**
 * Centralized image model configuration.
 * Model capabilities, dimension constraints, and provider associations.
 */

export type ImageProvider = 'local' | 'runpod' | 'gemini';

export interface ImageModelConfig {
  provider: ImageProvider;
  supportsReferenceImages: boolean;
  supportsNegativePrompt: boolean;
  supportsGuidanceScale: boolean;
  supportsSeed: boolean;
  dimensions:
    | { type: 'whitelist'; values: Array<{ width: number; height: number }> }
    | { type: 'range'; min: number; max: number; step: number };
}

const GEMINI_DIMENSIONS = [
  { width: 1024, height: 1024 },
  { width: 896, height: 1280 },
  { width: 1280, height: 896 },
  { width: 768, height: 1408 },
  { width: 1408, height: 768 },
] as const;

export const IMAGE_MODELS = {
  'imagen-4.0-generate-001': {
    provider: 'gemini',
    supportsReferenceImages: false,
    supportsNegativePrompt: true,
    supportsGuidanceScale: true,
    supportsSeed: true,
    dimensions: { type: 'whitelist', values: [...GEMINI_DIMENSIONS] },
  },
  'gemini-3-pro-image-preview': {
    provider: 'gemini',
    supportsReferenceImages: true,
    supportsNegativePrompt: false,
    supportsGuidanceScale: false,
    supportsSeed: false,
    dimensions: { type: 'whitelist', values: [...GEMINI_DIMENSIONS] },
  },
  'z-image-turbo': {
    provider: 'local',
    supportsReferenceImages: false,
    supportsNegativePrompt: false,
    supportsGuidanceScale: false,
    supportsSeed: false,
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
  'gemini-pro-image': 'gemini-3-pro-image-preview',
};

export function getModelIdForProvider(providerName: string): ImageModelId {
  return PROVIDER_TO_MODEL[providerName] || 'imagen-4.0-generate-001';
}

export function getModelConfig(modelId: ImageModelId): ImageModelConfig {
  return IMAGE_MODELS[modelId];
}

export function getDimensionsForModel(
  modelId: ImageModelId,
): Array<{ width: number; height: number }> {
  const config = IMAGE_MODELS[modelId];
  if (config.dimensions.type === 'whitelist') {
    return [...config.dimensions.values];
  }
  return [];
}

export function getSupportedDimensionsForProvider(
  providerName: string,
): Array<{ width: number; height: number }> {
  const modelId = getModelIdForProvider(providerName);
  return getDimensionsForModel(modelId);
}

export function mapToNearestSupportedDimensions(
  width: number,
  height: number,
  modelId: ImageModelId,
): [number, number] {
  const dims = getDimensionsForModel(modelId);
  if (dims.length === 0) return [width, height];

  const exact = dims.find((d) => d.width === width && d.height === height);
  if (exact) return [exact.width, exact.height];

  let nearest = dims[0];
  let minDist =
    Math.abs(nearest.width - width) + Math.abs(nearest.height - height);
  for (const d of dims) {
    const dist = Math.abs(d.width - width) + Math.abs(d.height - height);
    if (dist < minDist) {
      minDist = dist;
      nearest = d;
    }
  }
  return [nearest.width, nearest.height];
}

export function getAspectRatioString(width: number, height: number): string {
  const ratio = width / height;
  const ASPECT_RATIOS: Array<{ ratio: number; label: string }> = [
    { ratio: 1, label: '1:1' },
    { ratio: 1408 / 768, label: '16:9' },
    { ratio: 768 / 1408, label: '9:16' },
    { ratio: 1280 / 896, label: '4:3' },
    { ratio: 896 / 1280, label: '3:4' },
  ];

  let closest = ASPECT_RATIOS[0];
  let minDiff = Math.abs(ratio - closest.ratio);
  for (const ar of ASPECT_RATIOS) {
    const diff = Math.abs(ratio - ar.ratio);
    if (diff < minDiff) {
      minDiff = diff;
      closest = ar;
    }
  }
  return closest.label;
}

export function validateDimensionsForModel(
  width: number,
  height: number,
  modelId: ImageModelId,
): boolean {
  const config = IMAGE_MODELS[modelId];
  if (config.dimensions.type === 'range') {
    const { min, max } = config.dimensions;
    return width >= min && width <= max && height >= min && height <= max;
  }
  const requestedRatio = width / height;
  return config.dimensions.values.some((d) => {
    const supportedRatio = d.width / d.height;
    return Math.abs(supportedRatio - requestedRatio) < 0.1;
  });
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
  modelId: ImageModelId,
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

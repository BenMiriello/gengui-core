export const PRICING_CONSTANTS = {
  MARKUP_MULTIPLIER: 5,
  ANNUAL_MULTIPLIER: 0.8,
  UNITS_PER_DOLLAR: 1000,
} as const;

export type UserTier = 'free' | 'pro' | 'max' | 'admin';
export type GrantType = 'standard' | 'test_grant' | 'trial_approved' | 'paid';

export const API_COSTS = {
  llm: {
    'gemini-2.5-flash': {
      provider: 'google',
      inputCostPer1M: 0.3,
      outputCostPer1M: 2.5,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
    },
    'gemini-2.5-flash-lite': {
      provider: 'google',
      inputCostPer1M: 0.1,
      outputCostPer1M: 0.4,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
    },
    'gemini-2.5-pro': {
      provider: 'google',
      inputCostPer1M: 1.25,
      outputCostPer1M: 10.0,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
    },
    'gemini-2.0-flash': {
      provider: 'google',
      inputCostPer1M: 0.1,
      outputCostPer1M: 0.4,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
      notes: 'Same pricing as 2.0-flash-exp, different from 2.5-flash',
    },
  },
  image: {
    'imagen-4': {
      provider: 'google',
      costPerImage: 0.04,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
    },
    'gemini-2.5-flash-image': {
      provider: 'google',
      costPerImage: 0.039,
      source: 'https://ai.google.dev/pricing',
      verifiedDate: '2026-03-06',
      notes: 'Cheaper than Imagen 4',
    },
    'runpod-z-image-turbo': {
      provider: 'runpod',
      costPerImage: 0.005,
      source: 'https://www.runpod.io/pricing',
      verifiedDate: '2026-03-06',
    },
  },
} as const;

export function calculateLLMCost(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): { apiCostUsd: number; usageUnits: number } {
  const pricing = API_COSTS.llm[params.model as keyof typeof API_COSTS.llm];
  if (!pricing) {
    throw new Error(`Unknown LLM model: ${params.model}`);
  }

  const inputCost = (params.inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost =
    (params.outputTokens / 1_000_000) * pricing.outputCostPer1M;
  const apiCostUsd = inputCost + outputCost;

  const usageUnits = Math.ceil(
    apiCostUsd *
      PRICING_CONSTANTS.MARKUP_MULTIPLIER *
      PRICING_CONSTANTS.UNITS_PER_DOLLAR,
  );

  return { apiCostUsd, usageUnits };
}

export function calculateImageCost(params: {
  provider: 'runpod' | 'gemini' | 'gemini-pro-image';
  count?: number;
}): { apiCostUsd: number; usageUnits: number } {
  const modelKey =
    params.provider === 'runpod'
      ? 'runpod-z-image-turbo'
      : params.provider === 'gemini-pro-image'
        ? 'gemini-2.5-flash-image'
        : 'imagen-4';

  const pricing = API_COSTS.image[modelKey as keyof typeof API_COSTS.image];
  const apiCostUsd = pricing.costPerImage * (params.count || 1);

  const usageUnits = Math.ceil(
    apiCostUsd *
      PRICING_CONSTANTS.MARKUP_MULTIPLIER *
      PRICING_CONSTANTS.UNITS_PER_DOLLAR,
  );

  return { apiCostUsd, usageUnits };
}

export interface TierConfig {
  tier: UserTier;
  usageQuota: number;
  monthlyPrice: number;
  annualPrice: number;
  displayName: string;
}

export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  free: {
    tier: 'free',
    usageQuota: 500,
    monthlyPrice: 0,
    annualPrice: 0,
    displayName: 'Free',
  },
  pro: {
    tier: 'pro',
    usageQuota: 4000,
    monthlyPrice: 20,
    annualPrice: 192,
    displayName: 'Pro Subscription',
  },
  max: {
    tier: 'max',
    usageQuota: 20000,
    monthlyPrice: 100,
    annualPrice: 960,
    displayName: 'Max Subscription',
  },
  admin: {
    tier: 'admin',
    usageQuota: 2147483647,
    monthlyPrice: 0,
    annualPrice: 0,
    displayName: 'Admin',
  },
};

export interface ConcurrentLimits {
  maxConcurrent: number;
  maxInFlightCost: number;
}

export const TIER_CONCURRENT_LIMITS: Record<UserTier, ConcurrentLimits> = {
  free: {
    maxConcurrent: 10,
    maxInFlightCost: 50,
  },
  pro: {
    maxConcurrent: 30,
    maxInFlightCost: 400,
  },
  max: {
    maxConcurrent: 50,
    maxInFlightCost: 2000,
  },
  admin: {
    maxConcurrent: 100,
    maxInFlightCost: Number.MAX_SAFE_INTEGER,
  },
};

export const RISK_THRESHOLD = 0.9;

export type OperationType =
  | 'llm-query-1k-tokens'
  | 'image-standard'
  | 'image-character-consistency';

export interface OperationCost {
  operationType: OperationType;
  apiCostPer1kUnits: number;
  description: string;
}

function deriveImageCost(provider: keyof typeof API_COSTS.image): number {
  const apiCost = API_COSTS.image[provider].costPerImage;
  return (
    apiCost *
    PRICING_CONSTANTS.MARKUP_MULTIPLIER *
    PRICING_CONSTANTS.UNITS_PER_DOLLAR
  );
}

export const OPERATION_COSTS: Record<OperationType, OperationCost> = {
  'llm-query-1k-tokens': {
    operationType: 'llm-query-1k-tokens',
    apiCostPer1kUnits: 1.0,
    description: 'LLM query per 1k tokens',
  },
  'image-standard': {
    operationType: 'image-standard',
    apiCostPer1kUnits: deriveImageCost('imagen-4'),
    description: 'Standard image generation (Imagen 4)',
  },
  'image-character-consistency': {
    operationType: 'image-character-consistency',
    apiCostPer1kUnits: deriveImageCost('gemini-2.5-flash-image'),
    description: 'Character-consistent image (Gemini Pro)',
  },
};

export function calculateUsageUnits(
  operationType: OperationType,
  units: number = 1,
): number {
  const cost = OPERATION_COSTS[operationType];
  if (!cost) {
    throw new Error(`Unknown operation type: ${operationType}`);
  }

  const apiCost = (cost.apiCostPer1kUnits / 1000) * units;
  const usageUnits = apiCost * PRICING_CONSTANTS.UNITS_PER_DOLLAR;

  return Math.ceil(usageUnits);
}

export function getTierConfig(tier: UserTier): TierConfig {
  const config = TIER_CONFIGS[tier];
  if (!config) {
    throw new Error(`Unknown tier: ${tier}`);
  }
  return config;
}

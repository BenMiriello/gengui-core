export const PRICING_CONSTANTS = {
  MARKUP_MULTIPLIER: 5,
  ANNUAL_MULTIPLIER: 0.8,
  UNITS_PER_DOLLAR: 1000,
} as const;

export type UserTier = 'free' | 'pro' | 'max' | 'admin';
export type GrantType = 'standard' | 'test_grant' | 'trial_approved' | 'paid';

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

export const RISK_THRESHOLD = 0.90;

export type OperationType =
  | 'llm-query-1k-tokens'
  | 'image-standard'
  | 'image-character-consistency';

export interface OperationCost {
  operationType: OperationType;
  apiCostPer1kUnits: number;
  description: string;
}

export const OPERATION_COSTS: Record<OperationType, OperationCost> = {
  'llm-query-1k-tokens': {
    operationType: 'llm-query-1k-tokens',
    apiCostPer1kUnits: 1.0,
    description: 'LLM query per 1k tokens',
  },
  'image-standard': {
    operationType: 'image-standard',
    apiCostPer1kUnits: 4000,
    description: 'Standard image generation',
  },
  'image-character-consistency': {
    operationType: 'image-character-consistency',
    apiCostPer1kUnits: 6000,
    description: 'Character-consistent image generation',
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

/**
 * Context Budget Calculator
 *
 * Tiered architecture for dynamic token budget calculation:
 * - Tier 1: Universal batch calculator (calculator.ts)
 * - Tier 2: Operation-specific configs (operationConfigs.ts)
 * - Tier 3: Model configuration (text-models.ts)
 *
 * No magic numbers - calculates from actual data.
 */

// Tier 1: Universal calculator
export {
  type BatchBudgetInput,
  type BatchBudgetResult,
  balanceFinalBatches,
  buildEntityRegistry,
  type ContextBudgetInput,
  type ContextBudgetResult,
  calculateAllBatches,
  calculateBatchBudget,
  calculateContextBudget,
  countTokens,
  DEFAULT_OUTPUT_UTILIZATION,
  type EntityRegistryEntry,
  formatEntityEntry,
  validateBudget,
} from './calculator';

// Tier 2: Operation configs
export {
  batchedRelationshipConfig,
  crossSegmentRelationshipConfig,
  type EntityRegistryItem,
  entityRegistryConfig,
  estimateExtractionOutputTokens,
  extractionConfig,
  type OperationBudgetConfig,
  type RelationshipEntity,
  relationshipConfig,
  type SegmentForRelationshipBatch,
  type SegmentWithText,
  validateEstimationAccuracy,
} from './operationConfigs';

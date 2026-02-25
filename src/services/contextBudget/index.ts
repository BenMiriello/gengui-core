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
  balanceFinalBatches,
  type BatchBudgetInput,
  type BatchBudgetResult,
  buildEntityRegistry,
  calculateAllBatches,
  calculateBatchBudget,
  calculateContextBudget,
  type ContextBudgetInput,
  type ContextBudgetResult,
  countTokens,
  type EntityRegistryEntry,
  formatEntityEntry,
  validateBudget,
} from './calculator';

// Tier 2: Operation configs
export {
  batchedRelationshipConfig,
  calculateThinkingBudget,
  type EntityRegistryItem,
  entityRegistryConfig,
  estimateExtractionOutputTokens,
  extractionConfig,
  type OperationBudgetConfig,
  relationshipConfig,
  type RelationshipEntity,
  type SegmentForRelationshipBatch,
  type SegmentWithText,
  type ThinkingBudgetConfig,
  type ThinkingBudgetResult,
} from './operationConfigs';

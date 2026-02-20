/**
 * Context Budget Calculator
 *
 * Dynamic token budget calculation for LLM prompts.
 * No magic numbers - calculates from actual data.
 */

export {
  buildEntityRegistry,
  calculateContextBudget,
  type ContextBudgetInput,
  type ContextBudgetResult,
  countTokens,
  type EntityRegistryEntry,
  formatEntityEntry,
  validateBudget,
} from './calculator';

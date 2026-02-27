/**
 * Context Budget Calculator - Tiered Architecture
 *
 * Tier 1 (this file): Universal calculator logic - model and task agnostic
 * Tier 2 (operationConfigs.ts): Operation-specific formulas and formatting
 * Tier 3 (text-models.ts): Model configuration values
 *
 * Key principles:
 * - NO magic numbers - all values from config or measurement
 * - Multi-item batching - calculate how many items fit in context
 * - Batch balancing - avoid tiny final batches
 * - Runtime measurement - system prompts measured via actual templates
 */

import type { TextModelConfig } from '../../config/text-models';
import type { FacetInput } from '../../types/storyNodes';
import type { OperationBudgetConfig } from './operationConfigs';

/**
 * System-wide context window target for batch sizing.
 *
 * Conservative 80% target provides safety margin for token estimation variance.
 * Models can override via TextModelConfig.targetUtilization if needed.
 */
const DEFAULT_TARGET_UTILIZATION = 0.8;

/**
 * System-wide output capacity target for batch sizing.
 *
 * STAGED ROLLOUT PLAN:
 * - Stage 1 (current): 65% - Monitor 50+ batches for MAX_TOKENS errors
 * - Stage 2 (after validation): 70% - Monitor 50+ batches for MAX_TOKENS errors
 * - Stage 3 (final): 75% - Target utilization
 *
 * Rollback: If ANY MAX_TOKENS errors occur, revert to previous stage immediately.
 *
 * Conservative targets prevent MAX_TOKENS errors while allowing models
 * full output capacity if needed. Based on empirical data from Gemini 2.5 Flash.
 *
 * Models can override via TextModelConfig.outputUtilization if needed.
 */
export const DEFAULT_OUTPUT_UTILIZATION = 0.65;

// ============================================================================
// Generic Batch Budget Calculator (Tier 1)
// ============================================================================

export interface BatchBudgetInput<TItem> {
  modelConfig: TextModelConfig;
  operationConfig: OperationBudgetConfig<TItem>;
  items: TItem[];
  fixedContext?: string;
  startIndex?: number;
}

export interface BatchBudgetResult<TItem> {
  includedItems: TItem[];
  includedCount: number;
  excludedCount: number;
  nextStartIndex: number;
  isLastBatch: boolean;
  tokenBreakdown: {
    systemPrompt: number;
    fixedContext: number;
    items: number;
    outputReserve: number;
    total: number;
    /** Available context window tokens (input + output) */
    available: number;
    /** Available output tokens (separate limit) */
    availableOutput?: number;
  };
}

/**
 * Calculate how many items fit in a single batch.
 *
 * Uses operation config to measure prompt sizes and estimate output.
 * Returns items that fit within BOTH:
 * 1. Model's context budget (input + output combined)
 * 2. Model's output capacity (maxOutputTokens)
 *
 * This ensures we don't send so much input that the output would be truncated.
 */
export function calculateBatchBudget<TItem>(
  input: BatchBudgetInput<TItem>,
): BatchBudgetResult<TItem> {
  const { modelConfig, operationConfig, items, fixedContext, startIndex = 0 } = input;

  if (!modelConfig.maxTokens || !modelConfig.maxOutputTokens) {
    throw new Error(
      `Incomplete model config: missing token limits. ` +
      `maxTokens: ${modelConfig.maxTokens}, maxOutputTokens: ${modelConfig.maxOutputTokens}`
    );
  }

  const charsPerToken = modelConfig.charsPerToken ?? 3.3;
  const targetUtilization = modelConfig.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;
  const outputUtilization = modelConfig.outputUtilization ?? DEFAULT_OUTPUT_UTILIZATION;

  // Context window budget (input + output combined)
  const availableContextTokens = Math.floor(modelConfig.maxTokens * targetUtilization);

  // Output capacity budget (separate constraint)
  const maxOutputTokens = modelConfig.maxOutputTokens ?? 65536;
  const availableOutputTokens = Math.floor(maxOutputTokens * outputUtilization);

  // Measure system prompt at runtime (no magic numbers)
  const systemPromptTokens = operationConfig.getSystemPromptTokens(charsPerToken);

  // Fixed context tokens (e.g., previous segment for overlap)
  const fixedContextTokens = fixedContext
    ? countTokens(fixedContext, charsPerToken)
    : 0;

  // Prioritize items
  const remainingItems = items.slice(startIndex);
  const prioritizedItems = operationConfig.prioritize(remainingItems);

  // Measure each item's token cost
  const itemTokenCounts = prioritizedItems.map(
    (item) => countTokens(operationConfig.formatItem(item), charsPerToken),
  );

  // Greedily include items while respecting BOTH budgets:
  // 1. Context budget: system + fixed + items + output <= availableContextTokens
  // 2. Output budget: estimated output <= availableOutputTokens
  // Note: estimation is already conservative, no additional multiplier needed
  let includedCount = 0;
  let itemTokensUsed = 0;

  for (let i = 0; i < prioritizedItems.length; i++) {
    const candidateItems = prioritizedItems.slice(0, i + 1);
    const candidateItemTokens = itemTokenCounts.slice(0, i + 1).reduce((a, b) => a + b, 0);
    const candidateOutputReserve = operationConfig.estimateOutputReserve(candidateItems, charsPerToken);

    const totalContextTokens =
      systemPromptTokens +
      fixedContextTokens +
      candidateItemTokens +
      candidateOutputReserve;

    // Check BOTH constraints
    const fitsInContext = totalContextTokens <= availableContextTokens;
    const fitsInOutput = candidateOutputReserve <= availableOutputTokens;

    if (fitsInContext && fitsInOutput) {
      includedCount = i + 1;
      itemTokensUsed = candidateItemTokens;
    } else {
      break;
    }
  }

  const includedItems = prioritizedItems.slice(0, includedCount);
  const outputReserveTokens = operationConfig.estimateOutputReserve(includedItems, charsPerToken);

  return {
    includedItems,
    includedCount,
    excludedCount: remainingItems.length - includedCount,
    nextStartIndex: startIndex + includedCount,
    isLastBatch: startIndex + includedCount >= items.length,
    tokenBreakdown: {
      systemPrompt: systemPromptTokens,
      fixedContext: fixedContextTokens,
      items: itemTokensUsed,
      outputReserve: outputReserveTokens,
      total: systemPromptTokens + fixedContextTokens + itemTokensUsed + outputReserveTokens,
      available: availableContextTokens,
      availableOutput: availableOutputTokens,
    },
  };
}

/**
 * Calculate all batches needed to process items.
 *
 * Handles 1-item overlap between batches for continuity.
 * Balances final batches to avoid tiny remainders.
 */
export function calculateAllBatches<TItem>(
  input: Omit<BatchBudgetInput<TItem>, 'startIndex'> & {
    overlapSize?: number;
    getOverlapContext?: (lastItem: TItem) => string;
  },
): Array<BatchBudgetResult<TItem>> {
  const { items, overlapSize = 1, getOverlapContext, ...rest } = input;
  const batches: Array<BatchBudgetResult<TItem>> = [];

  let currentIndex = 0;

  while (currentIndex < items.length) {
    // For batches after the first, include overlap context
    let fixedContext = rest.fixedContext;
    if (currentIndex > 0 && getOverlapContext && batches.length > 0) {
      const lastBatch = batches[batches.length - 1];
      const lastItem = lastBatch.includedItems[lastBatch.includedItems.length - 1];
      if (lastItem) {
        const overlapText = getOverlapContext(lastItem);
        fixedContext = fixedContext ? `${fixedContext}\n${overlapText}` : overlapText;
      }
    }

    const batch = calculateBatchBudget({
      ...rest,
      items,
      fixedContext,
      startIndex: currentIndex,
    });

    if (batch.includedCount === 0) {
      const item = items[currentIndex];
      const itemSize = item ? countTokens(rest.operationConfig.formatItem(item), rest.modelConfig.charsPerToken ?? 3.3) : 0;
      throw new Error(
        `Batch calculation failed: Cannot fit any items in budget. ` +
        `First item size: ${itemSize} tokens, Available: ${batch.tokenBreakdown.available} tokens. ` +
        `This indicates items are too large for the model's context window or budget configuration is too tight.`
      );
    }

    batches.push(batch);

    // Check if we should balance final batches
    const remainingAfterBatch = items.length - batch.nextStartIndex;
    if (remainingAfterBatch > 0 && remainingAfterBatch < batch.includedCount) {
      // Remaining items would create a small final batch
      // Rebalance: split remaining items more evenly
      const totalRemaining = batch.includedCount + remainingAfterBatch - overlapSize;
      const balanced = balanceFinalBatches(totalRemaining, batch.includedCount, overlapSize);

      if (balanced.length === 2 && balanced[0] < batch.includedCount) {
        // Recalculate this batch with smaller size
        batches.pop();
        const rebalancedBatch = calculateBatchBudget({
          ...rest,
          items: items.slice(currentIndex, currentIndex + balanced[0]),
          fixedContext,
          startIndex: 0,
        });
        rebalancedBatch.nextStartIndex = currentIndex + balanced[0];
        rebalancedBatch.isLastBatch = false;
        batches.push(rebalancedBatch);
        currentIndex = currentIndex + balanced[0] - overlapSize;
        continue;
      }
    }

    // Move to next batch with overlap
    currentIndex = batch.nextStartIndex - overlapSize;
    if (currentIndex < 0) currentIndex = 0;
    if (batch.isLastBatch) break;
  }

  return batches;
}

/**
 * Balance batch sizes when remaining items < 2x batch capacity.
 *
 * Example: 22 remaining, capacity 20 → two batches of 11 (plus overlap)
 */
export function balanceFinalBatches(
  remainingCount: number,
  batchCapacity: number,
  overlapSize: number = 1,
): number[] {
  // If remaining fits in one batch, return single batch
  if (remainingCount <= batchCapacity) {
    return [remainingCount];
  }

  // If remaining is less than 2x capacity, balance into 2 batches
  const effectiveCapacity = batchCapacity - overlapSize;
  if (remainingCount < 2 * effectiveCapacity + overlapSize) {
    // Split evenly
    const halfWithOverlap = Math.ceil((remainingCount + overlapSize) / 2);
    return [halfWithOverlap, remainingCount - halfWithOverlap + overlapSize];
  }

  // Otherwise, fill first batch fully and recurse
  return [
    batchCapacity,
    ...balanceFinalBatches(remainingCount - effectiveCapacity, batchCapacity, overlapSize),
  ];
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate token count from character count.
 * Uses model-specific chars-per-token ratio.
 */
export function countTokens(text: string, charsPerToken: number): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Format a single entity for the registry.
 * Tiers: minimal (id+type+name), standard (+aliases), full (+summary)
 */
export function formatEntityEntry(
  entity: EntityRegistryEntry,
  tier: 'minimal' | 'standard' | 'full',
): string {
  const lines: string[] = [];

  lines.push(`[${entity.id.slice(0, 8)}] ${entity.type.toUpperCase()}: "${entity.name}"`);

  if (tier !== 'minimal' && entity.aliases && entity.aliases.length > 0) {
    lines.push(`  aliases: ${entity.aliases.join(', ')}`);
  }

  if (tier === 'full' && entity.summary) {
    lines.push(`  summary: ${entity.summary}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Legacy Interface (for gradual migration)
// ============================================================================

export interface EntityRegistryEntry {
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  summary?: string;
  facets?: Array<{ type: string; content: string }>;
  mentionCount?: number;
}

export interface ContextBudgetInput {
  modelConfig: TextModelConfig;
  entityRegistry: EntityRegistryEntry[];
  segmentText: string;
  previousSegmentText?: string;
  estimatedNewEntities?: number;
  systemPromptTokens?: number;
}

export interface ContextBudgetResult {
  fitsAllEntities: boolean;
  includedEntities: EntityRegistryEntry[];
  excludedCount: number;
  formattedRegistry: string;
  tokenBreakdown: {
    systemPrompt: number;
    entityRegistry: number;
    segmentText: number;
    previousSegment: number;
    outputReserve: number;
    total: number;
    available: number;
  };
}

const MIN_ENTITY_BUDGET = 250;

/**
 * Calculate context budget for single-segment extraction.
 *
 * Now uses runtime-measured system prompt tokens instead of magic number.
 * For multi-segment batching, use calculateBatchBudget instead.
 */
export function calculateContextBudget(
  input: ContextBudgetInput,
): ContextBudgetResult {
  const {
    modelConfig,
    entityRegistry,
    segmentText,
    previousSegmentText,
    estimatedNewEntities = 10,
    systemPromptTokens: providedSystemPromptTokens,
  } = input;

  const charsPerToken = modelConfig.charsPerToken ?? 3.3;
  const targetUtilization = modelConfig.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;
  const maxTokens = modelConfig.maxTokens;
  const availableTokens = Math.floor(maxTokens * targetUtilization);

  const outputReserveTokens = 150 * estimatedNewEntities;

  // Use provided system prompt tokens or fall back to estimation
  // Callers should measure actual prompt template and pass it in
  const systemPromptTokens = providedSystemPromptTokens ?? Math.ceil(3000 / charsPerToken);

  const segmentTokens = countTokens(segmentText, charsPerToken);
  const previousSegmentTokens = previousSegmentText
    ? countTokens(previousSegmentText, charsPerToken)
    : 0;

  const fixedCostTokens =
    systemPromptTokens +
    segmentTokens +
    previousSegmentTokens +
    outputReserveTokens;

  const entityBudgetTokens = availableTokens - fixedCostTokens;

  if (entityBudgetTokens < MIN_ENTITY_BUDGET) {
    console.warn(
      `Entity budget (${entityBudgetTokens} tokens) below floor (${MIN_ENTITY_BUDGET}). ` +
        `Consider reducing segment size or using larger context model.`,
    );
  }

  const sortedEntities = [...entityRegistry].sort(
    (a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0),
  );

  const includedEntities: EntityRegistryEntry[] = [];
  let currentTokens = 0;
  let tier: 'full' | 'standard' | 'minimal' = 'full';

  for (const entity of sortedEntities) {
    const formatted = formatEntityEntry(entity, tier);
    const entityTokens = countTokens(formatted, charsPerToken);

    if (currentTokens + entityTokens <= entityBudgetTokens) {
      includedEntities.push(entity);
      currentTokens += entityTokens;
    } else if (tier !== 'minimal') {
      tier = tier === 'full' ? 'standard' : 'minimal';
      const minimalFormatted = formatEntityEntry(entity, tier);
      const minimalTokens = countTokens(minimalFormatted, charsPerToken);

      if (currentTokens + minimalTokens <= entityBudgetTokens) {
        includedEntities.push(entity);
        currentTokens += minimalTokens;
      }
    }
  }

  const formattedRegistry = includedEntities
    .map((e) => formatEntityEntry(e, tier))
    .join('\n');

  return {
    fitsAllEntities: includedEntities.length === entityRegistry.length,
    includedEntities,
    excludedCount: entityRegistry.length - includedEntities.length,
    formattedRegistry,
    tokenBreakdown: {
      systemPrompt: systemPromptTokens,
      entityRegistry: currentTokens,
      segmentText: segmentTokens,
      previousSegment: previousSegmentTokens,
      outputReserve: outputReserveTokens,
      total:
        systemPromptTokens +
        currentTokens +
        segmentTokens +
        previousSegmentTokens +
        outputReserveTokens,
      available: availableTokens,
    },
  };
}

/**
 * Build entity registry from graph entities and their facets.
 */
export function buildEntityRegistry(
  entities: Array<{
    id: string;
    name: string;
    type: string;
    aliases?: string[];
    facets?: FacetInput[];
    mentionCount?: number;
  }>,
): EntityRegistryEntry[] {
  return entities.map((e) => {
    const nameFacets =
      e.facets?.filter((f) => f.type === 'name').map((f) => f.content) ?? [];
    const allAliases = [...(e.aliases ?? []), ...nameFacets];

    const traitFacets =
      e.facets
        ?.filter((f) => f.type === 'trait' || f.type === 'appearance')
        .map((f) => f.content) ?? [];

    const summary =
      traitFacets.length > 0 ? traitFacets.slice(0, 3).join('; ') : undefined;

    return {
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: allAliases.length > 0 ? [...new Set(allAliases)] : undefined,
      summary,
      mentionCount: e.mentionCount,
    };
  });
}

/**
 * Validate segment budget constraints.
 * Warns if budget is too tight for reliable extraction.
 */
export function validateBudget(result: ContextBudgetResult): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (result.excludedCount > 0) {
    warnings.push(
      `${result.excludedCount} entities excluded from context due to token budget`,
    );
  }

  const utilizationRatio =
    result.tokenBreakdown.total / result.tokenBreakdown.available;
  if (utilizationRatio > 0.95) {
    warnings.push(
      `Token utilization at ${(utilizationRatio * 100).toFixed(1)}% - near limit`,
    );
  }

  if (result.tokenBreakdown.entityRegistry < MIN_ENTITY_BUDGET) {
    warnings.push(
      `Entity registry budget (${result.tokenBreakdown.entityRegistry}) below minimum (${MIN_ENTITY_BUDGET})`,
    );
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

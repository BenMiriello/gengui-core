/**
 * Context Budget Calculator
 *
 * Dynamically calculates token budgets for LLM prompts based on:
 * - Model context window size
 * - Actual entity registry data
 * - Segment text size
 * - Reserved output space
 *
 * No magic numbers - all calculations from actual data.
 */

import type { TextModelConfig } from '../../config/text-models';
import type { FacetInput } from '../../types/storyNodes';

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

const SYSTEM_PROMPT_CHARS = 3000;
const MIN_ENTITY_BUDGET = 250;

/**
 * Estimate token count from character count.
 * Uses model-specific chars-per-token ratio.
 */
export function countTokens(text: string, charsPerToken: number): number {
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

/**
 * Calculate context budget and determine which entities fit.
 *
 * Strategy:
 * 1. Calculate fixed costs (system prompt, segment text, output reserve)
 * 2. Remaining budget goes to entity registry
 * 3. Include entities in priority order (most mentions first)
 * 4. Use tiered formatting (full → standard → minimal) as budget tightens
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
  } = input;

  const charsPerToken = modelConfig.charsPerToken ?? 3.3;
  const targetUtilization = modelConfig.targetUtilization ?? 0.8;
  const maxTokens = modelConfig.maxTokens;
  const availableTokens = Math.floor(maxTokens * targetUtilization);

  const outputReserveTokens = 150 * estimatedNewEntities;
  const systemPromptTokens = countTokens(
    ' '.repeat(SYSTEM_PROMPT_CHARS),
    charsPerToken,
  );
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

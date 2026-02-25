/**
 * Operation-specific budget configurations.
 *
 * Each config defines HOW to calculate budget for a specific LLM task type:
 * - System prompt measurement (at runtime, not hardcoded)
 * - Output reserve estimation (scales with input)
 * - Item formatting for prompts
 * - Priority ordering
 *
 * Tier 2 of the tiered calculator architecture.
 * Tier 1 = Universal calculator logic
 * Tier 3 = Model config (data only)
 */

import { extractEntitiesPrompt } from '../../prompts/storyNodes/extractEntities';
import { extractRelationshipsPrompt } from '../../prompts/storyNodes/extractRelationships';
import type { Segment } from '../segments';

/**
 * Configuration for thinking budget allocation.
 *
 * For models with "thinking" capabilities (like Gemini 2.5), thinking tokens
 * count against the output token limit. This config controls how to allocate
 * output capacity between thinking and actual response content.
 */
export interface ThinkingBudgetConfig {
  /**
   * Minimum output capacity to guarantee (absolute floor).
   * Even if estimation is low, never reserve less than this.
   */
  minOutputReserve: number;

  /**
   * Threshold below which thinking is disabled entirely.
   * If available thinking capacity < this, set thinkingBudget=0
   * and give all tokens to output.
   */
  disableThinkingThreshold: number;
}

/**
 * Result of thinking budget calculation.
 */
export interface ThinkingBudgetResult {
  /** Budget to set for thinking tokens (0 = disabled) */
  thinkingBudget: number;
  /** Total output tokens to request from API */
  maxOutputTokens: number;
  /** Guaranteed capacity available for actual response content */
  guaranteedResponseCapacity: number;
}

/**
 * Gemini 2.5 Flash thinking budget limit.
 * API rejects requests with thinking budget > 24576.
 */
const GEMINI_MAX_THINKING_BUDGET = 24576;

/**
 * Empirical observation: Gemini 2.5 uses approximately 30K thinking tokens
 * regardless of thinkingBudget hint. We must account for this actual usage
 * when reserving output space, even though we request less.
 *
 * Evidence: Batches with 9 segments showed ~30K thinking token usage even when
 * we requested 24K or less. The model ignores our hint and uses what it needs.
 */
const EMPIRICAL_THINKING_USAGE = 30000;

/**
 * Calculate thinking budget allocation for a given output estimate.
 *
 * CRITICAL: This function accounts for empirical thinking token usage (~30K)
 * rather than trusting the thinkingBudget hint, which the model ignores.
 *
 * Strategy:
 * 1. Assume model will use ~30K tokens for thinking (empirical observation)
 * 2. Reserve output space AFTER accounting for actual thinking usage
 * 3. Request conservative thinking budget (70% of empirical) as hint
 * 4. Keep thinking ENABLED (improves extraction quality)
 *
 * @param totalOutputCapacity - Total available output tokens (maxOutputTokens × utilization)
 * @param estimatedOutputTokens - Estimated tokens needed for actual response
 * @param config - Thinking budget configuration
 */
export function calculateThinkingBudget(
  totalOutputCapacity: number,
  estimatedOutputTokens: number,
  config: ThinkingBudgetConfig,
): ThinkingBudgetResult {
  // Calculate space needed for output (estimation is already conservative)
  const outputReserve = Math.max(config.minOutputReserve, estimatedOutputTokens);

  // Space available for thinking
  const availableForThinking = totalOutputCapacity - outputReserve;

  // Check if we should disable thinking
  if (availableForThinking < config.disableThinkingThreshold) {
    return {
      thinkingBudget: 0,
      maxOutputTokens: totalOutputCapacity,
      guaranteedResponseCapacity: totalOutputCapacity,
    };
  }

  // TEMPORARY: Thinking disabled while debugging
  return {
    thinkingBudget: 0,
    maxOutputTokens: totalOutputCapacity,
    guaranteedResponseCapacity: outputReserve,
  };
}

/**
 * Generic operation budget config interface.
 * TItem is the type of item being batched (Segment, Entity, etc.)
 */
export interface OperationBudgetConfig<TItem> {
  operationType: string;

  /**
   * Measure system prompt size at runtime.
   * Should call the actual prompt builder with minimal/typical values.
   */
  getSystemPromptTokens: (charsPerToken: number) => number;

  /**
   * Estimate output reserve based on included items.
   * Output size typically scales with input size.
   */
  estimateOutputReserve: (items: TItem[], charsPerToken: number) => number;

  /**
   * Format a single item for inclusion in the prompt.
   */
  formatItem: (item: TItem) => string;

  /**
   * Order items by priority (most important first).
   * Budget calculator will include items in this order until budget exhausted.
   */
  prioritize: (items: TItem[]) => TItem[];

  /**
   * Optional thinking budget configuration.
   * If provided, enables smart allocation of output capacity between
   * thinking tokens and response content for models that support thinking.
   */
  thinkingConfig?: ThinkingBudgetConfig;
}

/**
 * Segment with text content for extraction batching.
 * Includes index for tracking position in document order.
 */
export interface SegmentWithText extends Segment {
  text: string;
  index: number;
}

/**
 * Entity for relationship extraction.
 */
export interface RelationshipEntity {
  id: string;
  name: string;
  type: string;
  keyFacets: string[];
  segmentIds?: string[];
}

/**
 * Estimate extraction output tokens from total input characters.
 *
 * SINGLE SOURCE OF TRUTH for extraction output estimation.
 * Used by both the batch calculator and the client.
 *
 * Returns CONSERVATIVE estimate (20% buffer built in) to account for:
 * - Dense segments with more entities than average
 * - LLM generating more facets than minimum requirement
 * - Estimation uncertainty
 *
 * Combined with targetUtilization (0.8), provides adequate safety margin
 * without needing additional multipliers.
 *
 * Output JSON has THREE separate arrays: entities, facets, mentions
 * Based on actual extraction data (Dracula ch1-4, 69 entities from 55K chars):
 * - Entities array: ~1 entity per 800 input chars, ~100 tokens each
 * - Facets array: ~4.5 facets per entity, ~50 tokens each
 * - Mentions array: ~2.5 mentions per entity, ~30 tokens each
 * - Total per entity: 100 + (4.5 × 50) + (2.5 × 30) = 400 tokens
 */
export function estimateExtractionOutputTokens(totalInputChars: number): number {
  const estimatedEntities = Math.ceil(totalInputChars / 500);
  const tokensPerEntity = 120;
  const facetsPerEntity = 8;
  const tokensPerFacet = 60;
  const mentionsPerEntity = 4;
  const tokensPerMention = 35;

  const entityTokens = estimatedEntities * tokensPerEntity;
  const facetTokens = estimatedEntities * facetsPerEntity * tokensPerFacet;
  const mentionTokens = estimatedEntities * mentionsPerEntity * tokensPerMention;

  return entityTokens + facetTokens + mentionTokens;
}

/**
 * Extraction operation config.
 * Used for Stage 2: Entity + Facet extraction from text segments.
 */
export const extractionConfig: OperationBudgetConfig<SegmentWithText> = {
  operationType: 'extraction',

  getSystemPromptTokens: (charsPerToken: number) => {
    // Build prompt with minimal placeholder values to measure template size
    const template = extractEntitiesPrompt.build({
      segments: [{ id: 'placeholder', index: 0, text: '' }],
      totalSegments: 1,
      entityRegistry: [],
      overlapSegmentText: undefined,
    });
    return Math.ceil(template.length / charsPerToken);
  },

  estimateOutputReserve: (segments: SegmentWithText[], _charsPerToken: number) => {
    const totalInputChars = segments.reduce((sum, s) => sum + s.text.length, 0);
    return estimateExtractionOutputTokens(totalInputChars);
  },

  formatItem: (segment: SegmentWithText) => segment.text,

  prioritize: (segments: SegmentWithText[]) => {
    // Segments are processed in document order
    return [...segments].sort((a, b) => a.start - b.start);
  },

  // Thinking budget allocation for extraction
  // Note: thinking is currently DISABLED (returns 0) while we debug
  // Estimation is conservative (20% buffer) so no additional multiplier needed
  thinkingConfig: {
    minOutputReserve: 16384, // Minimum 16K tokens for response
    disableThinkingThreshold: 2048, // Disable thinking if < 2K tokens available
  },
};

/**
 * Relationship extraction operation config.
 * Used for Stage 5: Intra-segment relationship extraction.
 */
export const relationshipConfig: OperationBudgetConfig<RelationshipEntity> = {
  operationType: 'relationship',

  getSystemPromptTokens: (charsPerToken: number) => {
    const template = extractRelationshipsPrompt.build({
      segmentText: '',
      segmentIndex: 0,
      resolvedEntities: [],
    });
    return Math.ceil(template.length / charsPerToken);
  },

  estimateOutputReserve: (entities: RelationshipEntity[], _charsPerToken: number) => {
    // Estimate relationships: roughly n*(n-1)/2 potential edges, ~50 tokens per edge
    // In practice, much sparser - estimate 2 edges per entity on average
    const estimatedEdges = Math.min(entities.length * 2, (entities.length * (entities.length - 1)) / 2);
    const tokensPerEdge = 50;
    return estimatedEdges * tokensPerEdge;
  },

  formatItem: (entity: RelationshipEntity) => {
    const facets = entity.keyFacets.length > 0 ? entity.keyFacets.join(', ') : 'no facets';
    return `[${entity.id}] ${entity.type.toUpperCase()}: "${entity.name}" - ${facets}`;
  },

  prioritize: (entities: RelationshipEntity[]) => {
    // Entities with more segment appearances are more likely to have relationships
    return [...entities].sort((a, b) => {
      const aSegments = a.segmentIds?.length ?? 0;
      const bSegments = b.segmentIds?.length ?? 0;
      return bSegments - aSegments;
    });
  },
};

/**
 * Segment with entities for batched relationship extraction.
 */
export interface SegmentForRelationshipBatch {
  id: string;
  index: number;
  text: string;
  entities: Array<{
    id: string;
    name: string;
    type: string;
    keyFacets: string[];
    aliases?: string[];
  }>;
}

/**
 * Batched relationship extraction operation config.
 * Used for Stage 6: Extract relationships from multiple segments in one LLM call.
 * More verbose output than entity extraction - conservative batch size of 2-3 segments.
 */
export const batchedRelationshipConfig: OperationBudgetConfig<SegmentForRelationshipBatch> = {
  operationType: 'batched_relationship',

  getSystemPromptTokens: (charsPerToken: number) => {
    // Same prompt template as single-segment, just with multiple segments
    const template = extractRelationshipsPrompt.build({
      segmentText: '',
      segmentIndex: 0,
      resolvedEntities: [],
    });
    return Math.ceil(template.length / charsPerToken);
  },

  estimateOutputReserve: (segments: SegmentForRelationshipBatch[], _charsPerToken: number) => {
    // Relationships are verbose: assume ~8 relationships per segment, 100 tokens each
    // More conservative than single-entity config because relationships include:
    // - fromId, toId (UUIDs are long)
    // - edgeType (camelCase strings)
    // - description (3-10 words)
    // - strength (optional number)
    // - segmentId (NEW: track which segment this came from)
    const relationshipsPerSegment = 8;
    const tokensPerRelationship = 100;
    return segments.length * relationshipsPerSegment * tokensPerRelationship;
  },

  formatItem: (segment: SegmentForRelationshipBatch) => {
    // Format segment text + entities list
    const entitiesText = segment.entities
      .map((e) => {
        let line = `[${e.id}] ${e.type.toUpperCase()}: "${e.name}"`;
        if (e.aliases && e.aliases.length > 0) {
          line += ` (also: ${e.aliases.join(', ')})`;
        }
        line += ` - ${e.keyFacets.join(', ') || 'no facets'}`;
        return line;
      })
      .join('\n');

    return `SEGMENT ${segment.index + 1}:\n"""\n${segment.text}\n"""\n\nENTITIES:\n${entitiesText}`;
  },

  prioritize: (segments: SegmentForRelationshipBatch[]) => {
    // Segments are processed in document order
    return [...segments].sort((a, b) => a.index - b.index);
  },
};

/**
 * Registry entry for entity context in extraction prompts.
 */
export interface EntityRegistryItem {
  registryIndex: number;
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  summary?: string;
  mentionCount?: number;
}

/**
 * Entity registry config for budget calculations.
 * Used to determine how many existing entities fit in extraction prompts.
 */
export const entityRegistryConfig: OperationBudgetConfig<EntityRegistryItem> = {
  operationType: 'entity_registry',

  getSystemPromptTokens: (_charsPerToken: number) => {
    // Registry is part of extraction prompt, not a separate prompt
    // Return 0 - system prompt measured separately
    return 0;
  },

  estimateOutputReserve: (_entities: EntityRegistryItem[], _charsPerToken: number) => {
    // Registry is input context, not output
    return 0;
  },

  formatItem: (entity: EntityRegistryItem) => {
    let entry = `[${entity.registryIndex}] ${entity.type.toUpperCase()}: "${entity.name}"`;
    if (entity.aliases && entity.aliases.length > 0) {
      entry += `\n    aliases: ${entity.aliases.join(', ')}`;
    }
    if (entity.summary) {
      entry += `\n    summary: ${entity.summary}`;
    }
    return entry;
  },

  prioritize: (entities: EntityRegistryItem[]) => {
    // Most mentioned entities first - more likely to be referenced again
    return [...entities].sort((a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0));
  },
};

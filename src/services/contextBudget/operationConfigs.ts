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

import { extractEntitiesPrompt } from '../../prompts/entities/extractEntities';
import { extractRelationshipsPrompt } from '../../prompts/entities/extractRelationships';
import type { Segment } from '../segments';
import { batchCalibrator } from './calibrator';

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
 * Uses a direct empirical ratio (output tokens per input token) derived from
 * 39 batches of actual extraction data. This is more robust than the previous
 * compound formula (entity density × per-entity cost) which had 6 independently-
 * estimated parameters that happened to produce offsetting errors.
 *
 * Two-component model: base overhead + linear scaling.
 * Small documents have disproportionately high output/input ratios because
 * the model extracts exhaustively (high entity density per word) and there's
 * fixed JSON structure overhead regardless of input size. A pure linear formula
 * underestimates for small inputs.
 *
 * Can optionally use adaptive calibration based on actual batch results.
 */
export function estimateExtractionOutputTokens(
  totalInputChars: number,
  useCalibration = true,
): number {
  if (useCalibration && batchCalibrator.hasEnoughData()) {
    return batchCalibrator.getAdjustedEstimate(totalInputChars);
  }

  const charsPerToken = 3.3;
  const inputTokens = totalInputChars / charsPerToken;
  const baseOverhead = 4000;
  const marginalRatio = 4.0;
  const safetyMargin = 1.15;

  return Math.ceil((baseOverhead + inputTokens * marginalRatio) * safetyMargin);
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

  estimateOutputReserve: (
    segments: SegmentWithText[],
    _charsPerToken: number,
  ) => {
    const totalInputChars = segments.reduce((sum, s) => sum + s.text.length, 0);
    return estimateExtractionOutputTokens(totalInputChars);
  },

  formatItem: (segment: SegmentWithText) => segment.text,

  prioritize: (segments: SegmentWithText[]) => {
    // Segments are processed in document order
    return [...segments].sort((a, b) => a.start - b.start);
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

  estimateOutputReserve: (
    entities: RelationshipEntity[],
    _charsPerToken: number,
  ) => {
    // Estimate relationships: roughly n*(n-1)/2 potential edges, ~50 tokens per edge
    // In practice, much sparser - estimate 2 edges per entity on average
    const estimatedEdges = Math.min(
      entities.length * 2,
      (entities.length * (entities.length - 1)) / 2,
    );
    const tokensPerEdge = 50;
    return estimatedEdges * tokensPerEdge;
  },

  formatItem: (entity: RelationshipEntity) => {
    const facets =
      entity.keyFacets.length > 0 ? entity.keyFacets.join(', ') : 'no facets';
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
export const batchedRelationshipConfig: OperationBudgetConfig<SegmentForRelationshipBatch> =
  {
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

    estimateOutputReserve: (
      segments: SegmentForRelationshipBatch[],
      _charsPerToken: number,
    ) => {
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

  estimateOutputReserve: (
    _entities: EntityRegistryItem[],
    _charsPerToken: number,
  ) => {
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
    return [...entities].sort(
      (a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0),
    );
  },
};

/**
 * Cross-segment relationship extraction operation config.
 * Used for Stage 6: Extract relationships between entities across different segments.
 *
 * Output is MUCH larger than intra-segment because:
 * - Large entity lists in the prompt (all entities, not just one segment)
 * - Quadratic edge space (N entities = N*(N-1)/2 potential edges)
 * - Must avoid MAX_TOKENS by batching entities aggressively
 */
export const crossSegmentRelationshipConfig: OperationBudgetConfig<RelationshipEntity> =
  {
    operationType: 'cross_segment_relationship',

    getSystemPromptTokens: (charsPerToken: number) => {
      // System prompt includes edge types, rules, format template
      // Measured at ~4000 chars based on actual prompt
      return Math.ceil(4000 / charsPerToken);
    },

    estimateOutputReserve: (
      entities: RelationshipEntity[],
      _charsPerToken: number,
    ) => {
      // Cross-segment relationships have MUCH larger output than intra-segment:
      // - Each entity can relate to many others (not just in one segment)
      // - Output includes full relationship JSON: fromId, toId, edgeType, description, strength
      // - Empirical data: 47 entities -> 42k tokens (truncated), so ~900 tokens/entity
      //
      // Conservative estimate: 10 relationships per entity, 120 tokens per relationship
      // This accounts for:
      // - UUID-based entity IDs (long strings)
      // - Edge types (camelCase enums)
      // - Descriptions (3-10 words)
      // - Optional strength values
      // - JSON overhead (brackets, quotes, commas)
      const relationshipsPerEntity = 10;
      const tokensPerRelationship = 120;
      return entities.length * relationshipsPerEntity * tokensPerRelationship;
    },

    formatItem: (entity: RelationshipEntity) => {
      let entry = `[${entity.id}] ${entity.type.toUpperCase()}: "${entity.name}"`;
      if (entity.segmentIds && entity.segmentIds.length > 0) {
        entry += `\n    Segments: ${entity.segmentIds.join(', ')}`;
      }
      entry += `\n    Facets: ${entity.keyFacets.join(', ') || 'none'}`;
      return entry;
    },

    prioritize: (entities: RelationshipEntity[]) => {
      // Entities in multiple segments are more likely to have cross-segment relationships
      return [...entities].sort((a, b) => {
        const aSegments = a.segmentIds?.length ?? 0;
        const bSegments = b.segmentIds?.length ?? 0;
        return bSegments - aSegments;
      });
    },
  };

/**
 * Validate estimation accuracy and return warnings.
 *
 * Helps identify when estimates are consistently off, indicating need for
 * calibration adjustment or formula refinement.
 */
export function validateEstimationAccuracy(
  estimated: number,
  actual: number,
  operation: string,
): { isAccurate: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (estimated === 0 || actual === 0) {
    return { isAccurate: true, warnings };
  }

  const ratio = actual / estimated;

  if (ratio > 1.2) {
    warnings.push(
      `${operation}: Underestimated by ${((ratio - 1) * 100).toFixed(1)}% ` +
        `(estimated ${estimated}, actual ${actual}) - risk of truncation`,
    );
  }

  if (ratio < 0.7) {
    warnings.push(
      `${operation}: Overestimated by ${((1 - ratio) * 100).toFixed(1)}% ` +
        `(estimated ${estimated}, actual ${actual}) - could increase batch size`,
    );
  }

  return {
    isAccurate: ratio >= 0.8 && ratio <= 1.2,
    warnings,
  };
}

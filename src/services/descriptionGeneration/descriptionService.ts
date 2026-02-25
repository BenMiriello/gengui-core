/**
 * Description Generation Service
 *
 * Generates entity descriptions from facets using LLM.
 * Supports batching for efficiency and progressive updates using unified diffs.
 *
 * Key features:
 * - Batch processing (10-20 entities per call)
 * - Progressive updates with unified diff format
 * - Edit chain tracking with forced regeneration at N=10
 * - NO_CHANGE support to avoid unnecessary updates
 */

import type { FacetType } from '../../types/storyNodes';
import { BATCH_CONFIG, EDIT_CHAIN_CONFIG } from '../../utils/constants';
import {
  applyUnifiedDiff,
  extractDiffContent,
  isValidDiff,
} from '../../utils/diffUtils';
import { extractJson, isNoChangeResponse } from '../../utils/llmUtils';
import { logger } from '../../utils/logger';
import { graphService } from '../graph/graph.service';
import type { StoredCharacterState, StoredFacet } from '../graph/graph.types';

export interface EntityForDescription {
  id: string;
  name: string;
  type: string;
  permanentFacets: StoredFacet[];
  stateFacets: StoredFacet[];
  currentState?: StoredCharacterState | null;
  currentDescription?: string;
  editChainLength?: number;
}

export interface DescriptionResult {
  entityId: string;
  description: string;
  method: 'initial' | 'edit' | 'regenerate' | 'no_change';
  diff?: string;
  editChainLength: number;
}

export interface BatchDescriptionInput {
  entities: EntityForDescription[];
  forceRegenerate?: boolean;
}

/**
 * Build the prompt for generating descriptions for a batch of entities.
 */
function buildDescriptionPrompt(entities: EntityForDescription[]): string {
  const entityBlocks = entities.map((entity, idx) => {
    const permanentFacetLines = entity.permanentFacets
      .map((f) => `  - [${f.type}] ${f.content}`)
      .join('\n');

    const stateFacetLines = entity.stateFacets
      .map((f) => `  - [${f.type}] ${f.content}`)
      .join('\n');

    const stateInfo = entity.currentState
      ? `Current State: ${entity.currentState.name}`
      : 'No active state';

    return `### Entity ${idx + 1}: ${entity.name} (${entity.type})
${stateInfo}

Permanent Attributes:
${permanentFacetLines || '  (none)'}

Phase-Bounded Attributes:
${stateFacetLines || '  (none)'}`;
  });

  return `## TASK
Generate concise, narrative-ready descriptions for each entity based on their attributes.

## GUIDELINES
1. Focus on what makes each entity distinctive
2. For characters: combine appearance, personality, and current state naturally
3. For locations: emphasize atmosphere, key features, significance
4. For events: describe what happened and its importance
5. Keep each description 1-3 sentences (50-150 words)
6. Write in third person, present tense
7. Prioritize permanent attributes but incorporate state if relevant

## ENTITIES

${entityBlocks.join('\n\n')}

## OUTPUT FORMAT
Return a JSON array with one object per entity:
\`\`\`json
[
  {
    "entityIndex": 0,
    "description": "Description text here..."
  }
]
\`\`\`

Generate descriptions now:`;
}

/**
 * Build prompt for updating a description using unified diff format.
 */
function buildUpdatePrompt(
  entity: EntityForDescription,
  facetChanges: string,
): string {
  const permanentFacetLines = entity.permanentFacets
    .map((f) => `- [${f.type}] ${f.content}`)
    .join('\n');

  const stateFacetLines = entity.stateFacets
    .map((f) => `- [${f.type}] ${f.content}`)
    .join('\n');

  return `## TASK
Update the entity description based on facet changes.
Generate ONLY necessary changes as unified diff format.

## ENTITY: ${entity.name} (${entity.type})

## CURRENT DESCRIPTION
${entity.currentDescription}

## CURRENT FACETS
Permanent:
${permanentFacetLines || '(none)'}

Phase-Bounded:
${stateFacetLines || '(none)'}

## FACET CHANGES
${facetChanges}

## OUTPUT FORMAT
If changes needed, output unified diff:
\`\`\`diff
@@ -1,3 +1,3 @@
 unchanged line
-removed line
+added line
 unchanged line
\`\`\`

If NO significant change needed, output exactly: NO_CHANGE

## RULES
1. Change only what's necessary to reflect the facet changes
2. Preserve the description's existing style and structure
3. Do not add information not warranted by the facets
4. Do not remove information unless facets were removed
5. Keep description concise (50-150 words)`;
}

interface DescriptionResponseItem {
  entityIndex: number;
  description: string;
}

/**
 * Parse LLM response for batch description generation.
 */
function parseDescriptionResponse(
  response: string,
  entities: EntityForDescription[],
): Map<number, string> {
  const results = new Map<number, string>();

  // Try to extract JSON using shared utility
  const parsed = extractJson<DescriptionResponseItem[]>(response);

  if (parsed && Array.isArray(parsed)) {
    for (const item of parsed) {
      if (
        typeof item.entityIndex === 'number' &&
        typeof item.description === 'string'
      ) {
        results.set(item.entityIndex, item.description);
      }
    }

    if (results.size > 0) {
      return results;
    }
  }

  // Fallback: try to extract descriptions by pattern matching
  logger.warn({ responsePreview: response.slice(0, 200) }, 'JSON parse failed, using pattern fallback');

  for (let i = 0; i < entities.length; i++) {
    const pattern = new RegExp(
      `Entity ${i + 1}[^:]*:\\s*([^#]+?)(?=Entity ${i + 2}|$)`,
      'i',
    );
    const match = response.match(pattern);
    if (match) {
      results.set(i, match[1].trim());
    }
  }

  return results;
}

/**
 * Generate descriptions for a batch of entities.
 * Uses LLM to create narrative-ready descriptions from facets.
 */
async function generateDescriptionsBatch(
  entities: EntityForDescription[],
  llmGenerate: (prompt: string) => Promise<string>,
): Promise<DescriptionResult[]> {
  if (entities.length === 0) {
    return [];
  }

  const prompt = buildDescriptionPrompt(entities);
  const response = await llmGenerate(prompt);
  const descriptions = parseDescriptionResponse(response, entities);

  return entities.map((entity, idx) => ({
    entityId: entity.id,
    description: descriptions.get(idx) || deriveFallbackDescription(entity),
    method: 'initial' as const,
    editChainLength: 0,
  }));
}

/**
 * Fallback description when LLM fails.
 */
function deriveFallbackDescription(entity: EntityForDescription): string {
  const allFacets = [...entity.permanentFacets, ...entity.stateFacets];
  const appearanceFacets = allFacets.filter((f) => f.type === 'appearance');
  const traitFacets = allFacets.filter((f) => f.type === 'trait');

  const parts: string[] = [];

  if (appearanceFacets.length > 0) {
    parts.push(appearanceFacets.map((f) => f.content).join(', '));
  }

  if (traitFacets.length > 0) {
    parts.push(traitFacets.map((f) => f.content).join(', '));
  }

  return parts.join('. ') || `A ${entity.type} named ${entity.name}.`;
}

/**
 * Update a single entity's description using progressive edit.
 */
async function updateDescriptionProgressive(
  entity: EntityForDescription,
  facetChanges: string,
  llmGenerate: (prompt: string) => Promise<string>,
): Promise<DescriptionResult> {
  const editChainLength = entity.editChainLength ?? 0;

  // Force regeneration if chain too long
  if (editChainLength >= EDIT_CHAIN_CONFIG.maxLength) {
    logger.info(
      { entityId: entity.id, editChainLength },
      'Forcing regeneration due to edit chain length',
    );

    const results = await generateDescriptionsBatch([entity], llmGenerate);
    return {
      ...results[0],
      method: 'regenerate',
      editChainLength: 0,
    };
  }

  // Try minimal edit
  const prompt = buildUpdatePrompt(entity, facetChanges);
  const response = await llmGenerate(prompt);

  // Check for NO_CHANGE using shared utility (handles case variations)
  if (isNoChangeResponse(response)) {
    return {
      entityId: entity.id,
      description: entity.currentDescription || '',
      method: 'no_change',
      editChainLength,
    };
  }

  // Try to extract and apply diff using shared utilities
  const extractedDiff = extractDiffContent(response);
  if (extractedDiff && isValidDiff(extractedDiff)) {
    try {
      const updatedDescription = applyUnifiedDiff(
        entity.currentDescription || '',
        extractedDiff,
      );

      return {
        entityId: entity.id,
        description: updatedDescription,
        method: 'edit',
        diff: extractedDiff,
        editChainLength: editChainLength + 1,
      };
    } catch (err) {
      logger.warn(
        { entityId: entity.id, error: err },
        'Failed to apply diff, checking if response is valid replacement',
      );
    }
  }

  // Response wasn't a valid diff
  // Only use as replacement if it looks like actual description content
  const looksLikeDescription =
    response.length > 30 && !response.includes('@@') && !response.startsWith('-');

  if (looksLikeDescription) {
    return {
      entityId: entity.id,
      description: response.trim(),
      method: 'regenerate',
      editChainLength: 0,
    };
  }

  // Keep current description if response is garbled
  logger.warn(
    { entityId: entity.id, responsePreview: response.slice(0, 100) },
    'Invalid update response, keeping current description',
  );

  return {
    entityId: entity.id,
    description: entity.currentDescription || '',
    method: 'no_change',
    editChainLength,
  };
}

export const descriptionService = {
  /**
   * Generate descriptions for multiple entities in batches.
   */
  async generateBatch(
    input: BatchDescriptionInput,
    llmGenerate: (prompt: string) => Promise<string>,
  ): Promise<DescriptionResult[]> {
    const { entities, forceRegenerate } = input;

    if (entities.length === 0) {
      return [];
    }

    // Split entities into those needing generation vs update
    const needsGeneration: EntityForDescription[] = [];
    const needsUpdate: EntityForDescription[] = [];

    for (const entity of entities) {
      if (forceRegenerate || !entity.currentDescription) {
        needsGeneration.push(entity);
      } else if ((entity.editChainLength ?? 0) >= EDIT_CHAIN_CONFIG.maxLength) {
        needsGeneration.push(entity);
      } else {
        needsUpdate.push(entity);
      }
    }

    const results: DescriptionResult[] = [];

    // Process generation in batches
    for (let i = 0; i < needsGeneration.length; i += BATCH_CONFIG.descriptionBatchSize) {
      const batch = needsGeneration.slice(i, i + BATCH_CONFIG.descriptionBatchSize);
      const batchResults = await generateDescriptionsBatch(batch, llmGenerate);
      results.push(...batchResults);
    }

    // Process updates individually (they need entity-specific context)
    for (const entity of needsUpdate) {
      // For updates, we'd need to know what changed. For now, regenerate.
      // In a full implementation, we'd track facet changes and pass them.
      const result = await generateDescriptionsBatch([entity], llmGenerate);
      results.push({
        ...result[0],
        editChainLength: (entity.editChainLength ?? 0) + 1,
      });
    }

    return results;
  },

  /**
   * Generate description for a single entity using its facets at a position.
   */
  async generateForEntityAtPosition(
    entityId: string,
    userId: string,
    position: number,
    llmGenerate: (prompt: string) => Promise<string>,
  ): Promise<DescriptionResult | null> {
    const stateInfo = await graphService.getEntityStateAtPosition(
      entityId,
      userId,
      position,
    );

    if (!stateInfo) {
      return null;
    }

    const entity: EntityForDescription = {
      id: entityId,
      name: stateInfo.entity.name,
      type: stateInfo.entity.type,
      permanentFacets: stateInfo.permanentFacets,
      stateFacets: stateInfo.stateFacets,
      currentState: stateInfo.activeState,
      currentDescription: stateInfo.entity.description || undefined,
    };

    const results = await generateDescriptionsBatch([entity], llmGenerate);
    return results[0] || null;
  },

  /**
   * Update an entity's description based on facet changes.
   * Uses progressive edit with unified diff format.
   */
  async updateDescription(
    entity: EntityForDescription,
    facetChanges: string,
    llmGenerate: (prompt: string) => Promise<string>,
  ): Promise<DescriptionResult> {
    return updateDescriptionProgressive(entity, facetChanges, llmGenerate);
  },

  /**
   * Group facets by type for display.
   */
  groupFacetsByType(
    facets: StoredFacet[],
  ): Record<FacetType, StoredFacet[]> {
    const grouped: Record<string, StoredFacet[]> = {};

    for (const facet of facets) {
      if (!grouped[facet.type]) {
        grouped[facet.type] = [];
      }
      grouped[facet.type].push(facet);
    }

    return grouped as Record<FacetType, StoredFacet[]>;
  },

  // Export config values for external use
  MAX_EDIT_CHAIN_LENGTH: EDIT_CHAIN_CONFIG.maxLength,
  DEFAULT_BATCH_SIZE: BATCH_CONFIG.descriptionBatchSize,
};

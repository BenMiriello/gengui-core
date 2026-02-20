/**
 * Stage 3: Entity Resolution
 *
 * Decides if extracted entities match existing graph entities.
 * Sequential processing - each decision affects subsequent decisions.
 *
 * Decisions:
 * - MERGE: Extracted entity IS the existing entity (combine)
 * - UPDATE: Add new mentions to existing entity
 * - ADD_FACET: Add new facet(s) to existing entity
 * - NEW: Create new entity (no match found)
 */

import type { PromptDefinition } from '../types';

interface ResolveEntityInput {
  extractedEntity: {
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentions: Array<{ text: string }>;
  };
  candidates: Array<{
    id: string;
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentionCount: number;
    similarityScore: number;
  }>;
  documentContext?: string;
}

/**
 * Stage 3 prompt for entity resolution.
 * Analyzes one extracted entity against candidate matches.
 */
export const resolveEntityPrompt: PromptDefinition<ResolveEntityInput> = {
  id: 'stage3-resolve-entity',
  version: 1,
  model: 'gemini-2.5-flash',
  description: 'Stage 3: Decide if an extracted entity matches existing entities',

  build: ({ extractedEntity, candidates, documentContext }) => {
    const extractedFacetsByType: Record<string, string[]> = {};
    for (const f of extractedEntity.facets) {
      if (!extractedFacetsByType[f.type]) extractedFacetsByType[f.type] = [];
      extractedFacetsByType[f.type].push(f.content);
    }

    const candidatesSection = candidates.length > 0
      ? candidates.map((c, i) => {
          const cFacetsByType: Record<string, string[]> = {};
          for (const f of c.facets) {
            if (!cFacetsByType[f.type]) cFacetsByType[f.type] = [];
            cFacetsByType[f.type].push(f.content);
          }
          return `
CANDIDATE ${i + 1}: [ID: ${c.id}] "${c.name}" (${c.type})
  Similarity Score: ${(c.similarityScore * 100).toFixed(1)}%
  Mentions: ${c.mentionCount}
  Names: ${cFacetsByType['name']?.join(', ') || 'none'}
  Appearance: ${cFacetsByType['appearance']?.join(', ') || 'none'}
  Traits: ${cFacetsByType['trait']?.join(', ') || 'none'}
  States: ${cFacetsByType['state']?.join(', ') || 'none'}`;
        }).join('\n')
      : '\n(No candidates found - entity will be created as NEW)';

    const contextSection = documentContext
      ? `
DOCUMENT CONTEXT (for understanding narrative reveals):
"""
${documentContext}
"""
`
      : '';

    return `Decide if this extracted entity matches any existing entity.

EXTRACTED ENTITY: "${extractedEntity.name}" (${extractedEntity.type})
  Names: ${extractedFacetsByType['name']?.join(', ') || 'none'}
  Appearance: ${extractedFacetsByType['appearance']?.join(', ') || 'none'}
  Traits: ${extractedFacetsByType['trait']?.join(', ') || 'none'}
  States: ${extractedFacetsByType['state']?.join(', ') || 'none'}
  Mentions: ${extractedEntity.mentions.map((m) => `"${m.text}"`).join(', ')}
${candidatesSection}
${contextSection}
DECISION OPTIONS:

**MERGE** - The extracted entity IS the same as an existing entity
  Use when: Same character referred to by different name (alias, title, nickname)
  Example: "strange driver" is later revealed to be "Count Dracula"
  Output: {"decision": "MERGE", "targetEntityId": "...", "reason": "..."}

**UPDATE** - Reference to existing entity, no new information
  Use when: Simple mention of already-known entity
  Output: {"decision": "UPDATE", "targetEntityId": "...", "reason": "..."}

**ADD_FACET** - Existing entity with NEW facets discovered
  Use when: New appearance detail, trait, or state for known entity
  Output: {"decision": "ADD_FACET", "targetEntityId": "...", "newFacets": [...], "reason": "..."}

**NEW** - Genuinely new entity not matching any candidate
  Use when: No candidates match, or candidates are clearly different entities
  Output: {"decision": "NEW", "reason": "..."}

RESOLUTION RULES:
1. Consider NARRATIVE CONTEXT - authors reveal identities progressively
2. "Strange driver" appearing before "Count Dracula" = likely same character
3. Shared distinctive appearance facets strongly suggest match
4. Type mismatch (character vs location) = definitely different entities
5. When uncertain but >70% likely same: prefer MERGE over NEW
6. When adding facets, include the name of extracted entity as a name facet

OUTPUT FORMAT:
\`\`\`json
{
  "decision": "MERGE|UPDATE|ADD_FACET|NEW",
  "targetEntityId": "id of matched entity (omit for NEW)",
  "newFacets": [{"type": "...", "content": "..."}],
  "reason": "Brief explanation of decision"
}
\`\`\``;
  },
};

interface BatchResolveInput {
  extractedEntities: Array<{
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentions: Array<{ text: string }>;
    candidateIds: string[];
  }>;
  allCandidates: Array<{
    id: string;
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentionCount: number;
  }>;
  documentContext?: string;
}

/**
 * Batch resolution prompt for processing multiple entities at once.
 * More efficient than individual calls but less nuanced.
 */
export const batchResolveEntitiesPrompt: PromptDefinition<BatchResolveInput> = {
  id: 'stage3-batch-resolve-entities',
  version: 1,
  model: 'gemini-2.5-flash',
  description: 'Stage 3: Batch resolve multiple extracted entities',

  build: ({ extractedEntities, allCandidates, documentContext }) => {
    const extractedSection = extractedEntities.map((e, i) => {
      const facetsByType: Record<string, string[]> = {};
      for (const f of e.facets) {
        if (!facetsByType[f.type]) facetsByType[f.type] = [];
        facetsByType[f.type].push(f.content);
      }
      return `
[${i + 1}] "${e.name}" (${e.type})
    Names: ${facetsByType['name']?.join(', ') || 'none'}
    Appearance: ${facetsByType['appearance']?.join(', ') || 'none'}
    Candidates: ${e.candidateIds.length > 0 ? e.candidateIds.join(', ') : 'none'}`;
    }).join('\n');

    const candidatesSection = allCandidates.map((c) => {
      const facetsByType: Record<string, string[]> = {};
      for (const f of c.facets) {
        if (!facetsByType[f.type]) facetsByType[f.type] = [];
        facetsByType[f.type].push(f.content);
      }
      return `[${c.id}] "${c.name}" (${c.type}): ${facetsByType['name']?.join(', ') || 'no aliases'}`;
    }).join('\n');

    const contextSection = documentContext
      ? `
DOCUMENT CONTEXT:
"""
${documentContext}
"""
`
      : '';

    return `Resolve each extracted entity against potential candidates.

EXTRACTED ENTITIES:
${extractedSection}

CANDIDATE POOL:
${candidatesSection}
${contextSection}
For EACH extracted entity, output a resolution:

\`\`\`json
{
  "resolutions": [
    {"extractedIndex": 0, "decision": "MERGE|UPDATE|ADD_FACET|NEW", "targetEntityId": "...", "newFacets": [...], "reason": "..."},
    ...
  ]
}
\`\`\`

RULES:
1. Process in order - earlier decisions inform later ones
2. If entity X merges with candidate A, entity Y cannot also merge with A
3. Prefer MERGE when entities are clearly the same
4. ADD_FACET when new details discovered about existing entity
5. NEW only when no reasonable match exists`;
  },
};

/**
 * Stage 4: Relationship Extraction
 *
 * Extracts edges between RESOLVED entity IDs (not names).
 * Input: segment text + resolved entity IDs with types/facets.
 * Parallel processing per segment.
 */

import type { PromptDefinition } from '../types';

interface ExtractRelationshipsInput {
  segmentText: string;
  segmentIndex: number;
  resolvedEntities: Array<{
    id: string;
    name: string;
    type: string;
    keyFacets: string[];
  }>;
}

/**
 * Stage 4 prompt for relationship extraction from a single segment.
 * Uses entity IDs, not names, for stable references.
 */
export const extractRelationshipsPrompt: PromptDefinition<ExtractRelationshipsInput> =
  {
    id: 'stage4-extract-relationships',
    version: 1,
    model: 'gemini-2.5-flash',
    description:
      'Stage 4: Extract relationships between resolved entities in a segment',

    build: ({ segmentText, segmentIndex, resolvedEntities }) => {
      const entitiesSection = resolvedEntities
        .map((e) => {
          return `[${e.id}] ${e.type.toUpperCase()}: "${e.name}" - ${e.keyFacets.join(', ') || 'no facets'}`;
        })
        .join('\n');

      return `Extract relationships between entities in this segment.

SEGMENT ${segmentIndex + 1}:
"""
${segmentText}
"""

RESOLVED ENTITIES IN THIS SEGMENT:
${entitiesSection}

OUTPUT FORMAT:
\`\`\`json
{
  "relationships": [
    {
      "fromId": "entity-id-1",
      "toId": "entity-id-2",
      "edgeType": "EDGE_TYPE",
      "description": "brief description of relationship",
      "strength": 0.8
    }
  ]
}
\`\`\`

EDGE TYPES:

**Layer 2 - Causal/Temporal (MUST include strength 0-1):**
- CAUSES: A directly causes B (necessary and sufficient)
- ENABLES: A makes B possible but doesn't guarantee it
- PREVENTS: A blocks B from occurring
- HAPPENS_BEFORE: Temporal only (use sparingly - text position often suffices)

**Layer 3 - Structural/Relational:**
- PARTICIPATES_IN: Agent involved in event
- LOCATED_AT: Entity exists/occurs at location
- PART_OF: Component of containing entity (chapter of book)
- MEMBER_OF: Belongs to group while retaining identity
- POSSESSES: Ownership or control
- CONNECTED_TO: Social/professional connection between agents
- OPPOSES: Conflict, antagonism, opposition
- ABOUT: Entity relates to abstract concept/theme
- RELATED_TO: Fallback (use sparingly, <5% of edges)

RULES:
1. Use entity IDs from the list above - not names
2. Only extract relationships EVIDENCED in this segment text
3. For causal edges (CAUSES, ENABLES, PREVENTS), include strength 0-1
4. Prefer specific edge types over RELATED_TO
5. Do NOT create edges between entities not in the segment
6. Description should be 3-10 words explaining the relationship

QUALITY CHECKLIST:
- Character interactions -> CONNECTED_TO or OPPOSES
- Character in event -> PARTICIPATES_IN
- Entity at place -> LOCATED_AT
- One event causing another -> CAUSES with strength
- Object owned by character -> POSSESSES`;
    },
  };

interface ExtractCrossSegmentInput {
  documentSummary?: string;
  allEntities: Array<{
    id: string;
    name: string;
    type: string;
    segmentIds: string[];
    keyFacets: string[];
  }>;
  existingRelationships: Array<{
    fromId: string;
    toId: string;
    edgeType: string;
  }>;
}

/**
 * Stage 4b prompt for cross-segment relationship extraction.
 * Sequential processing after all segments are analyzed.
 */
export const extractCrossSegmentRelationshipsPrompt: PromptDefinition<ExtractCrossSegmentInput> =
  {
    id: 'stage4b-extract-cross-segment-relationships',
    version: 1,
    model: 'gemini-2.5-flash',
    description:
      'Stage 4b: Extract relationships between entities in different segments',

    build: ({ documentSummary, allEntities, existingRelationships }) => {
      const entitiesSection = allEntities
        .map((e) => {
          return `[${e.id}] ${e.type.toUpperCase()}: "${e.name}"
    Segments: ${e.segmentIds.join(', ')}
    Facets: ${e.keyFacets.join(', ') || 'none'}`;
        })
        .join('\n\n');

      const existingSection =
        existingRelationships.length > 0
          ? `
EXISTING RELATIONSHIPS (already extracted from segments):
${existingRelationships.map((r) => `  ${r.fromId} --[${r.edgeType}]--> ${r.toId}`).join('\n')}
`
          : '';

      const summarySection = documentSummary
        ? `
DOCUMENT OVERVIEW:
"""
${documentSummary}
"""
`
        : '';

      return `Extract relationships between entities that span DIFFERENT segments.

${summarySection}
ALL RESOLVED ENTITIES:
${entitiesSection}
${existingSection}
FOCUS ON:
- Characters who interact across scenes (different segments)
- Events that cause effects in later segments
- Thematic connections spanning the narrative
- Relationships NOT already captured above

OUTPUT FORMAT:
\`\`\`json
{
  "relationships": [
    {
      "fromId": "entity-id-1",
      "toId": "entity-id-2",
      "edgeType": "EDGE_TYPE",
      "description": "brief description",
      "strength": 0.8
    }
  ]
}
\`\`\`

RULES:
1. Only add relationships NOT in existing list
2. Focus on cross-segment connections
3. For CAUSES/ENABLES/PREVENTS between events in different segments = strong signal
4. Character arc connections (same character, different states) = ABOUT theme
5. Do NOT duplicate existing relationships`;
    },
  };

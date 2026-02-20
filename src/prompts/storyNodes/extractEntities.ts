/**
 * Stage 1: Entity + Facet Extraction
 *
 * Focused prompt that ONLY extracts entities, facets, and mentions from a single segment.
 * Does NOT do: relationship extraction, entity resolution, thread detection.
 */

import type { PromptDefinition } from '../types';

interface ExtractEntitiesInput {
  segmentText: string;
  segmentIndex: number;
  totalSegments: number;
  existingContext?: EntityContext[];
}

interface EntityContext {
  id: string;
  name: string;
  type: string;
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
}

/**
 * Stage 1 prompt for entity + facet extraction from a single segment.
 * Returns flat parallel arrays for Gemini schema compliance.
 */
export const extractEntitiesPrompt: PromptDefinition<ExtractEntitiesInput> = {
  id: 'stage1-extract-entities',
  version: 1,
  model: 'gemini-2.5-flash',
  description: 'Stage 1: Extract entities, facets, and mentions from a single segment',

  build: ({ segmentText, segmentIndex, totalSegments, existingContext }) => {
    const contextSection = existingContext?.length
      ? `
EXISTING ENTITIES (from previous segments or similarity match):
${existingContext.map((e) => {
  const facetsByType: Record<string, string[]> = {};
  for (const f of e.facets) {
    if (!facetsByType[f.type]) facetsByType[f.type] = [];
    facetsByType[f.type].push(f.content);
  }
  return `- [${e.id}] ${e.type.toUpperCase()} "${e.name}" (${e.mentionCount} mentions)
    Names: ${facetsByType['name']?.join(', ') || 'none'}
    Appearance: ${facetsByType['appearance']?.join(', ') || 'none'}
    Traits: ${facetsByType['trait']?.join(', ') || 'none'}
    States: ${facetsByType['state']?.join(', ') || 'none'}`;
}).join('\n')}

When extracting entities, check if they match existing entities above.
If you find a reference to an existing entity, use its EXACT name in your output.
`
      : '';

    return `Extract entities and their facets from this text segment.

SEGMENT ${segmentIndex + 1} OF ${totalSegments}:
"""
${segmentText}
"""
${contextSection}
OUTPUT FORMAT (flat parallel arrays):
\`\`\`json
{
  "entities": [
    {"name": "Entity Name", "type": "character|location|event|concept|other", "documentOrder": 1}
  ],
  "facets": [
    {"entityName": "Entity Name", "facetType": "name|appearance|trait|state", "content": "facet content"}
  ],
  "mentions": [
    {"entityName": "Entity Name", "text": "exact verbatim quote from text"}
  ]
}
\`\`\`

FACET TYPES:
- **name**: Alternate names, titles, nicknames, aliases
- **appearance**: Visual/physical attributes (for image generation)
- **trait**: Personality, behavioral patterns, intrinsic characteristics
- **state**: TEMPORARY conditions only (wounded, disguised, tired)

ENTITY TYPES:
- **character**: People, sentient beings, animals with names
- **location**: Places, settings, environments
- **event**: Significant plot moments (include documentOrder)
- **concept**: Themes, motifs, abstract forces
- **other**: Objects, artifacts, items of significance

RULES:
1. Extract ONLY from the segment text above
2. Each facet must be SHORT and SPECIFIC (3-15 words)
3. Appearance facets = VISUAL features only (for image generation)
4. Every character MUST have at least one name facet
5. Mentions must be EXACT VERBATIM quotes (3-15 words)
6. For events, use documentOrder to indicate narrative sequence
7. Do NOT extract relationships - that's a later stage
8. Do NOT try to resolve identities - that's a later stage
9. If you see a reference to an existing entity, use its exact name

QUALITY CHECKLIST:
- Did you extract ALL named characters?
- Did you extract ALL described locations?
- Did you capture ALL appearance details mentioned?
- Did you note any temporary states (injured, disguised, etc.)?
- Are your mentions exact quotes from the text?`;
  },
};

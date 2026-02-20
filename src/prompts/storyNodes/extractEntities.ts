/**
 * Stage 1: Entity + Facet Extraction with LLM-First Merge Detection
 *
 * This prompt extracts entities, facets, and mentions from a single segment
 * while actively identifying potential matches to existing entities.
 *
 * Key features:
 * - Entity registry with known entities from previous segments
 * - Explicit existingMatch field for each entity (LLM decides matches)
 * - mergeSignals for cross-entity alias detection
 * - Better facet guidance for inferred characteristics
 */

import type { PromptDefinition } from '../types';

interface EntityRegistryEntry {
  registryIndex: number;
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  summary?: string;
}

interface ExtractEntitiesInput {
  segmentText: string;
  segmentIndex: number;
  totalSegments: number;
  entityRegistry?: EntityRegistryEntry[];
  previousSegmentText?: string;
}

/**
 * Format entity registry for prompt inclusion.
 * Tiered format based on available information.
 */
function formatEntityRegistry(registry: EntityRegistryEntry[]): string {
  if (!registry || registry.length === 0) {
    return 'No existing entities yet.';
  }

  return registry
    .map((e) => {
      let entry = `[${e.registryIndex}] ${e.type.toUpperCase()}: "${e.name}"`;
      if (e.aliases && e.aliases.length > 0) {
        entry += `\n    aliases: ${e.aliases.join(', ')}`;
      }
      if (e.summary) {
        entry += `\n    summary: ${e.summary}`;
      }
      return entry;
    })
    .join('\n');
}

/**
 * Stage 1 prompt with LLM-first merge detection.
 * Returns flat parallel arrays for Gemini schema compliance.
 */
export const extractEntitiesPrompt: PromptDefinition<ExtractEntitiesInput> = {
  id: 'stage1-extract-entities-v2',
  version: 2,
  model: 'gemini-2.5-flash',
  description:
    'Stage 1: Extract entities with LLM-first merge detection',

  build: ({
    segmentText,
    segmentIndex,
    totalSegments,
    entityRegistry,
    previousSegmentText,
  }) => {
    const registrySection = entityRegistry?.length
      ? `
## ENTITY REGISTRY (Known entities from previous segments)
${formatEntityRegistry(entityRegistry)}

CRITICAL: For EVERY entity you extract, you MUST check if it matches one of these existing entities.
The same entity may appear with different names:
- Titles: "Count Dracula" = "the Count" = "Dracula"
- Epithets: "the driver" might = "Count Dracula" if context suggests identity
- Pronouns in narration: descriptions like "the stranger" or "the old man"
- Nicknames: "Harry" = "Mr. Potter" = "the boy who lived"

When you find a match, set existingMatch with the registryIndex.
When uncertain but suspicious, add to mergeSignals.
`
      : '';

    const previousSegmentSection = previousSegmentText
      ? `
## PREVIOUS SEGMENT (Read-only context - do NOT extract from this)
"""
${previousSegmentText}
"""
(Use this only to understand continuity. Extract entities only from CURRENT SEGMENT below.)
`
      : '';

    return `You are extracting entities from a narrative text segment. Your primary goals:
1. Extract ALL entities (characters, locations, events, concepts, objects)
2. Actively identify which extracted entities match existing ones
3. Capture rich facets including INFERRED characteristics

${registrySection}
${previousSegmentSection}
## CURRENT SEGMENT ${segmentIndex + 1} OF ${totalSegments} (Extract from this)
"""
${segmentText}
"""

## OUTPUT FORMAT
\`\`\`json
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "character|location|event|concept|other",
      "documentOrder": 1,
      "existingMatch": {
        "registryIndex": 0,
        "confidence": "high|medium|low",
        "reason": "Why this matches the existing entity"
      }
    }
  ],
  "facets": [
    {"entityName": "Entity Name", "facetType": "name|appearance|trait|state", "content": "facet content"}
  ],
  "mentions": [
    {"entityName": "Entity Name", "text": "exact verbatim quote"}
  ],
  "mergeSignals": [
    {
      "extractedEntityName": "the driver",
      "registryIndex": 3,
      "confidence": "medium",
      "evidence": "Described at same location, similar physical description"
    }
  ]
}
\`\`\`

## ENTITY MATCHING RULES
For each entity you extract:
1. **Check ALL registry entries** - especially those with matching type
2. **Consider narrative context** - who could this entity actually be?
3. **Look for identity clues** - same location, same actions, same relationships
4. **Be generous with matching** - if there's reasonable evidence, set existingMatch
5. **Use mergeSignals for uncertainty** - when you suspect but aren't sure

existingMatch confidence levels:
- **high**: Clear match (exact name, alias, or obvious reference)
- **medium**: Strong contextual evidence (same role, location, description)
- **low**: Possible match, needs verification

## FACET TYPES
- **name**: Alternate names, titles, nicknames, epithets, references
  Include ALL ways this entity is referred to in text
- **appearance**: Visual/physical attributes (for image generation)
  Include BOTH explicit AND inferred visual traits
  "tall" "pale" "wearing a cloak" - even if implied by type (e.g., vampire)
- **trait**: Personality, behavioral patterns, intrinsic characteristics
  Include demonstrated behaviors, not just stated traits
- **state**: TEMPORARY conditions only (wounded, disguised, tired)
  Must be changeable within the narrative

## APPEARANCE FACETS - IMPORTANT
For visual characters, extract:
- Explicit descriptions: "tall and pale"
- Implied attributes: a coachman likely wears a coat, a count wears formal attire
- Environmental suggestions: characters in cold settings may be bundled up
- Type-implied features: supernatural beings often have distinctive eyes

## ENTITY TYPES
- **character**: People, sentient beings, animals with agency
- **location**: Places, settings, environments, buildings
- **event**: Significant plot moments (use documentOrder for sequence)
- **concept**: Themes, motifs, abstract forces
- **other**: Objects, artifacts, items of narrative significance

## RULES
1. Extract ONLY from the CURRENT SEGMENT text
2. Each facet: 3-15 words, SHORT and SPECIFIC
3. Mentions must be EXACT VERBATIM quotes (3-15 words)
4. For events, use documentOrder to indicate narrative sequence
5. Do NOT extract relationships - that's a later stage
6. If no existing entities match, omit existingMatch field
7. If you find NO potential merges, omit mergeSignals or return empty array

## QUALITY CHECKLIST
Before submitting, verify:
- Did you check EVERY extracted entity against the registry?
- Did you extract ALL characters mentioned in the segment?
- Did you capture appearance details (explicit AND inferred)?
- Did you note any temporary states (injured, disguised, etc.)?
- Are your mentions exact quotes from the text?
- Did you consider whether descriptive phrases ("the driver") match named entities?`;
  },
};

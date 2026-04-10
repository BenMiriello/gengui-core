/**
 * Stage 2: Entity + Facet Extraction with LLM-First Merge Detection
 *
 * Supports both single-segment and multi-segment batch extraction.
 * Multi-segment batching improves efficiency by processing multiple
 * segments in a single LLM call.
 *
 * Key features:
 * - Entity registry with known entities from previous batches
 * - Explicit existingMatch field for each entity (LLM decides matches)
 * - mergeSignals for cross-entity alias detection
 * - Facet guidance for inferred characteristics
 * - Segment attribution for batch processing
 */

import type { EntityRegistryEntry } from '../../services/gemini/client';
import type { PromptDefinition } from '../types';

interface SegmentInput {
  id: string;
  index: number;
  text: string;
}

interface SegmentSummary {
  index: number;
  summary: string;
}

interface ExtractEntitiesInput {
  segments: SegmentInput[];
  totalSegments: number;
  entityRegistry?: EntityRegistryEntry[];
  overlapSegmentText?: string;
  segmentSummaries?: SegmentSummary[];
  documentSummary?: string;
}

/**
 * Format entity registry for prompt inclusion.
 * Compact single-line format reduces token usage by ~30-40%.
 */
function formatEntityRegistry(
  registry: EntityRegistryEntry[],
  useCompact = true,
): string {
  if (!registry || registry.length === 0) {
    return 'No existing entities yet.';
  }

  if (useCompact) {
    return registry
      .map((e) => {
        let entry = `[${e.registryIndex}] ${e.type.toUpperCase()}: "${e.name}"`;
        if (e.aliases && e.aliases.length > 0) {
          entry += ` (aka: ${e.aliases.join(', ')})`;
        }
        if (e.summary) {
          entry += ` | ${e.summary}`;
        }
        return entry;
      })
      .join('\n');
  }

  // Multi-line fallback (if compact causes issues)
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
 * Format segments for prompt inclusion.
 */
function formatSegments(
  segments: SegmentInput[],
  totalSegments: number,
): string {
  return segments
    .map(
      (s) =>
        `### SEGMENT ${s.index + 1} OF ${totalSegments} [id: ${s.id}]\n"""\n${s.text}\n"""`,
    )
    .join('\n\n');
}

/**
 * Format event chain for prompt inclusion.
 * Shows previous events in document order.
 */
function formatEventChain(registry: EntityRegistryEntry[]): string {
  const events = registry
    .filter(
      (e) =>
        e.type === 'event' && e.segmentIndices && e.segmentIndices.length > 0,
    )
    .map((e) => ({
      name: e.name,
      segmentIndex: e.segmentIndices ? Math.min(...e.segmentIndices) : 0,
    }))
    .sort((a, b) => a.segmentIndex - b.segmentIndex);

  if (events.length === 0) {
    return '';
  }

  const eventLines = events.map(
    (e) => `- "${e.name}" (segment ${e.segmentIndex + 1})`,
  );

  return `
## PREVIOUS EVENTS (Document Order)
${eventLines.join('\n')}

Use this to understand what has happened earlier in the narrative.
`;
}

/**
 * Stage 2 prompt with LLM-first merge detection.
 * Supports batch extraction of multiple segments.
 */
export const extractEntitiesPrompt: PromptDefinition<ExtractEntitiesInput> = {
  id: 'stage2-extract-entities-batch',
  version: 3,
  model: process.env.ENTITY_EXTRACTION_MODEL || 'gemini-2.5-flash',
  description:
    'Stage 2: Extract entities with LLM-first merge detection (batch support)',

  build: ({
    segments,
    totalSegments,
    entityRegistry,
    overlapSegmentText,
    segmentSummaries,
    documentSummary,
  }) => {
    const documentSummarySection = documentSummary
      ? `
## DOCUMENT CONTEXT
${documentSummary}
`
      : '';

    const summariesSection = segmentSummaries?.length
      ? `
## RELEVANT SEGMENT SUMMARIES
${segmentSummaries.map((s) => `[Segment ${s.index + 1}]: ${s.summary}`).join('\n')}
`
      : '';

    const registrySection = entityRegistry?.length
      ? `
## ENTITY REGISTRY (${entityRegistry.length} known entities from previous batches)
${formatEntityRegistry(entityRegistry)}

CRITICAL: For EVERY entity you extract, you MUST check if it matches one of these existing entities.
The same entity may appear with different names:
- Titles: "Count Dracula" = "the Count" = "Dracula"
- Epithets: "the driver" might = "Count Dracula" if context suggests identity
- Pronouns in narration: descriptions like "the stranger" or "the old man"
- Nicknames: "Harry" = "Mr. Potter" = "the boy who lived"

When you find a match:
- Set existingMatch.matchedName to the EXACT name from the registry (e.g., "Count Dracula")
- Set existingMatch.matchedType to the EXACT type from the registry (e.g., "person")
- Provide a reason explaining the evidence for the match

When uncertain but suspicious, add to mergeSignals with registryName and registryType.
`
      : `
## ENTITY REGISTRY
No existing entities yet. This is the first batch of this stage.
ALL entities you extract will be NEW entities.
Do NOT set existingMatch for any entities - leave that field unset.
`;

    const overlapSection = overlapSegmentText
      ? `
## OVERLAP CONTEXT (Read-only - do NOT extract from this)
"""
${overlapSegmentText}
"""
(Use this only to understand continuity. Extract entities only from SEGMENTS below.)
`
      : '';

    const eventChainSection = formatEventChain(entityRegistry || []);

    const segmentWord = segments.length === 1 ? 'segment' : 'segments';
    const segmentIndices = segments.map((s) => s.index + 1).join(', ');

    return `You are extracting entities from ${segments.length} narrative text ${segmentWord}. Your primary goals:
1. Extract relevant entities (people, places, events, concepts, objects) from each segment
2. Actively identify which extracted entities match existing ones
3. Capture rich facets including INFERRED characteristics
4. Track which segment each entity comes from using segmentId

${documentSummarySection}
${summariesSection}
${registrySection}
${eventChainSection}
${overlapSection}
## SEGMENTS TO EXTRACT FROM (${segmentWord} ${segmentIndices} of ${totalSegments})

${formatSegments(segments, totalSegments)}

## OUTPUT FORMAT
\`\`\`json
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "person|place|event|concept|object",
      "segmentId": "segment-uuid",
      "documentOrder": 1,
      "existingMatch": {
        "matchedName": "Exact Name From Registry",
        "matchedType": "person|place|event|concept|object",
        "confidence": "high|medium|low",
        "reason": "Why this matches the existing entity"
      }
    }
  ],
  "facets": [
    {"entityName": "Entity Name", "segmentId": "segment-uuid", "facetType": "name|appearance|trait|state", "content": "facet content"}
  ],
  "mentions": [
    {"entityName": "Entity Name", "segmentId": "segment-uuid", "text": "exact verbatim quote"}
  ],
  "mergeSignals": [
    {
      "extractedEntityName": "the driver",
      "registryName": "Count Dracula",
      "registryType": "person",
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

## FACET TYPES - STRICT DEFINITIONS

**trait**: PERMANENT characteristics
  Include: personality ("brave"), skills ("fluent in French"), permanent physical ("tall")
  Exclude: actions, temporary states, current emotions

**state**: TEMPORARY conditions
  Include: physical ("wounded"), emotional ("angry"), situational ("disguised")
  Exclude: actions being performed, permanent traits

**appearance**: VISUAL attributes
  Include: physical features, clothing, visible conditions
  For image generation - focus on what can be SEEN
  Extract only what the text states or clearly implies.

**name**: Identifiers
  Include: proper names, titles, epithets
  Exclude: pronouns (he/she/they), generic descriptions (the man)

## ENTITY TYPES
- **person**: People, sentient beings, animals with agency
- **place**: Places, settings, environments, buildings
- **event**: Actions, occurrences, and happenings that drive the narrative forward
  Include: arrivals/departures, meetings, discoveries, battles, decisions, conversations, ceremonies, deaths, births
  Include events that drive the plot or mark meaningful transitions.
  Minor logistics (walking between rooms, eating meals) are not events unless narratively significant.
  Always set documentOrder to preserve narrative sequence
  Name events as noun phrases describing the action
- **concept**: Themes, motifs, abstract forces
- **object**: Physical items, artifacts, possessions, tools of narrative significance

## RULES
1. Extract ONLY from the SEGMENTS provided (not from overlap context)
2. Include segmentId for EVERY entity, facet, and mention
3. Each facet: a concise, specific observation — a phrase, not a sentence
4. Mentions: exact verbatim phrases from the text identifying or describing the entity. Use the shortest phrase that captures the reference — a name, epithet, or brief identifying clause. Not full sentences or passages.
5. For events, use documentOrder to indicate narrative sequence
6. Do NOT extract relationships - that's a later stage
7. If no existing entities match, omit existingMatch field
8. If you find NO potential merges, omit mergeSignals or return empty array
9. Each unique entity needs ONE entry per batch. Use the segmentId of the segment where the entity is most prominent. Facets and mentions carry their own segmentId to track which segment each observation comes from.

Ensure every entity, facet, and mention has the correct segmentId.`;
  },
};

/**
 * Legacy single-segment interface for backwards compatibility during migration.
 * @deprecated Use batch interface with segments array instead.
 */
export interface LegacyExtractEntitiesInput {
  segmentText: string;
  segmentIndex: number;
  totalSegments: number;
  entityRegistry?: EntityRegistryEntry[];
  previousSegmentText?: string;
}

/**
 * Convert legacy single-segment input to batch format.
 */
export function convertLegacyInput(
  input: LegacyExtractEntitiesInput,
  segmentId: string,
): ExtractEntitiesInput {
  return {
    segments: [
      {
        id: segmentId,
        index: input.segmentIndex,
        text: input.segmentText,
      },
    ],
    totalSegments: input.totalSegments,
    entityRegistry: input.entityRegistry,
    overlapSegmentText: input.previousSegmentText,
  };
}

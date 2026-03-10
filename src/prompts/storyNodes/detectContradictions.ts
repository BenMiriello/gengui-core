/**
 * Stage 10: Facet Contradiction Detection
 *
 * Analyzes all facets of the same type for a single entity to detect contradictions.
 * Uses batch processing: send ALL facets of same type to LLM in one call.
 *
 * Classifications:
 * - true_inconsistency: Mutually exclusive facts (needs user review)
 * - temporal_change: Character evolution over time (not a conflict)
 * - arc_divergence: Multiple valid interpretations (not a conflict)
 */

import type { FacetType } from '../../types/storyNodes';
import type { PromptDefinition } from '../types';

interface DetectContradictionsInput {
  entityName: string;
  facetType: FacetType;
  facets: Array<{ content: string }>;
}

/**
 * Stage 10 prompt for batch contradiction detection.
 * Analyzes all facets of same type to find contradictions.
 */
export const detectContradictionsPrompt: PromptDefinition<DetectContradictionsInput> =
  {
    id: 'stage10-detect-contradictions',
    version: 1,
    model: 'gemini-2.5-flash',
    description:
      'Stage 10: Identify contradictions in facets of the same type for an entity',

    build: ({ entityName, facetType, facets }) => {
      const facetList = facets.map((f, i) => `[${i}] ${f.content}`).join('\n');

      return `You are analyzing ${facetType} facets for the character "${entityName}".
Below are all ${facetType} facets extracted from the text.

Your task: Identify pairs of facets that need classification. You will classify each pair as one of three types:

## CLASSIFICATION TYPES

**1. true_inconsistency** - Mutually exclusive facts that CANNOT both be true:
- "has blue eyes" vs "has brown eyes" (physically impossible)
- "died in Chapter 3" vs "appears alive in Chapter 5" (logically impossible)
- "is human" vs "is a plant" (mutually exclusive identities)
- "tall" vs "short", "young" vs "elderly" (contradictory attributes)

**2. temporal_change** - Character evolution or changed circumstances over time:
- "timid" vs "confident" (growth arc)
- "wealthy" vs "impoverished" (circumstances changed)
- "trusts John" vs "distrusts John" (relationship evolved)
- ONLY use this if facets suggest chronological progression, not incompatibility

**3. arc_divergence** - Multiple valid interpretations from different perspectives:
- "hero" vs "villain" (POV-dependent)
- "morally ambiguous" vs "ruthless" (interpretation difference)
- ONLY use this if BOTH can be true from different viewpoints

## DO NOT FLAG (these are compatible, not issues):
- Synonyms: "brave" vs "courageous"
- Rephrasing: "tall" vs "very tall"
- Compatible attributes: "smart", "kind", "brave" (all can be true)
- Elaborations: "wears red" vs "wears a red cloak with gold trim"
- Vague vs specific: "old" vs "67 years old"
- General vs detailed: "lives in London" vs "lives on Baker Street"

## FACETS TO ANALYZE:
${facetList}

## OUTPUT FORMAT:
Return a JSON array. Each entry is a pair of facets with their classification:

[
  {
    "facetIndexA": 0,
    "facetIndexB": 3,
    "classificationType": "true_inconsistency",
    "reasoning": "Blue eyes and brown eyes are mutually exclusive"
  },
  {
    "facetIndexA": 1,
    "facetIndexB": 5,
    "classificationType": "temporal_change",
    "reasoning": "Character evolved from timid to confident over the story"
  }
]

Return empty array [] if no pairs need classification.

## IMPORTANT:
- BE CONSERVATIVE: Only flag pairs that clearly fit one of the three types
- If uncertain whether facets conflict, do NOT flag them
- "true_inconsistency" means IMPOSSIBLE for both to be true simultaneously
- "temporal_change" means BOTH are true but at different times
- "arc_divergence" means BOTH are valid interpretations from different perspectives`;
    },
  };

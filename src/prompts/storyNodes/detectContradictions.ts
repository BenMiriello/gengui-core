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

import type { PromptDefinition } from '../types';
import type { FacetType } from '../../types/storyNodes';

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
      const facetList = facets
        .map((f, i) => `[${i}] ${f.content}`)
        .join('\n');

      return `You are analyzing ${facetType} facets for the character "${entityName}".
Below are all ${facetType} facets extracted from the text.

Your task: Identify ONLY true contradictions - mutually exclusive facts that cannot both be true.

IMPORTANT DISTINCTIONS:

✅ TRUE CONTRADICTIONS (flag these):
- Mutually exclusive states: "has blue eyes" vs "has brown eyes"
- Incompatible facts: "died in Chapter 3" vs "appears alive in Chapter 5"
- Direct opposites: "is human" vs "is a vampire"
- Contradictory attributes: "tall" vs "short", "young" vs "elderly"

❌ NOT CONTRADICTIONS (do NOT flag):
- Synonyms: "brave" vs "courageous"
- Rephrasing: "tall" vs "very tall" vs "six feet tall"
- Multiple compatible attributes: "smart", "kind", "brave" (all can be true)
- Elaborations: "wears red" vs "wears a red cloak with gold trim"
- Vague vs specific: "old" vs "67 years old"
- General vs detailed: "lives in London" vs "lives on Baker Street in London"

⏱️ TEMPORAL CHANGES (classify separately):
- Character evolution: "timid" (early chapters) → "confident" (later chapters)
- Changed circumstances: "wealthy" (Chapter 1) → "impoverished" (Chapter 5)
- Changed relationships: "trusts John" → "distrusts John"
- Only flag as temporal_change if you can infer chronological progression

🔀 ARC DIVERGENCES (classify separately):
- POV-dependent: "hero" (protagonist view) vs "villain" (antagonist view)
- Multiple interpretations: "morally ambiguous" vs "ruthless"
- Only flag if both interpretations are valid from different perspectives

Facets to analyze:
${facetList}

Return JSON array of contradictions:
[
  {
    "facetIndexA": 0,
    "facetIndexB": 3,
    "classificationType": "true_inconsistency" | "temporal_change" | "arc_divergence",
    "reasoning": "Brief explanation of why this is a contradiction"
  }
]

Return empty array [] if no contradictions found.

BE CONSERVATIVE: When in doubt, do NOT flag as a contradiction. Only flag pairs where the facts are clearly mutually exclusive.`;
    },
  };

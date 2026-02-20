/**
 * Stage 5: Higher-Order Analysis
 *
 * Identifies narrative threads and character arcs from the complete graph.
 * Uses algorithmic thread detection + LLM refinement.
 * Sequential processing after all entities and relationships are extracted.
 */

import type { PromptDefinition } from '../types';

interface AnalyzeHigherOrderInput {
  /** Events in document order */
  events: Array<{
    id: string;
    name: string;
    documentOrder: number;
    connectedCharacterIds: string[];
    causalEdges: Array<{
      type: 'CAUSES' | 'ENABLES' | 'PREVENTS';
      targetId: string;
      strength: number;
    }>;
  }>;
  /** Characters with their appearances */
  characters: Array<{
    id: string;
    name: string;
    participatesInEventIds: string[];
    stateFacetsBySegment: Array<{
      segmentIndex: number;
      states: string[];
    }>;
  }>;
  /** Algorithmically detected thread candidates (connected components) */
  threadCandidates: Array<{
    eventIds: string[];
    characterIds: string[];
  }>;
  /** Document summary for context */
  documentSummary?: string;
}

/**
 * Stage 5 prompt for narrative thread and character arc detection.
 */
export const analyzeHigherOrderPrompt: PromptDefinition<AnalyzeHigherOrderInput> =
  {
    id: 'stage5-analyze-higher-order',
    version: 1,
    model: 'gemini-2.5-flash',
    description: 'Stage 5: Identify narrative threads and character arcs',

    build: ({ events, characters, threadCandidates, documentSummary }) => {
      const eventsSection = events
        .map((e) => {
          const causalStr =
            e.causalEdges.length > 0
              ? `  Causal: ${e.causalEdges.map((c) => `${c.type}(${c.strength}) -> ${c.targetId}`).join(', ')}`
              : '';
          return `[${e.id}] #${e.documentOrder}: "${e.name}"
  Characters: ${e.connectedCharacterIds.join(', ') || 'none'}${causalStr}`;
        })
        .join('\n');

      const charactersSection = characters
        .map((c) => {
          const statesStr = c.stateFacetsBySegment
            .map((s) => `Seg ${s.segmentIndex}: ${s.states.join(', ')}`)
            .join(' | ');
          return `[${c.id}] "${c.name}"
  Events: ${c.participatesInEventIds.join(', ') || 'none'}
  States: ${statesStr || 'no state changes'}`;
        })
        .join('\n\n');

      const candidatesSection =
        threadCandidates.length > 0
          ? `
THREAD CANDIDATES (algorithmically detected connected components):
${threadCandidates
  .map(
    (t, i) =>
      `  Candidate ${i + 1}: Events [${t.eventIds.join(', ')}], Characters [${t.characterIds.join(', ')}]`,
  )
  .join('\n')}
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

      return `Analyze the narrative structure of this document.

${summarySection}
EVENTS (in document order):
${eventsSection}

CHARACTERS:
${charactersSection}
${candidatesSection}
OUTPUT TWO ANALYSES:

**1. NARRATIVE THREADS**
Group events into named storylines:
\`\`\`json
{
  "narrativeThreads": [
    {
      "name": "Short descriptive name",
      "isPrimary": true,
      "eventIds": ["ev-1", "ev-3", "ev-5"],
      "description": "One sentence summary of this plot thread"
    }
  ]
}
\`\`\`

**2. ARC PHASES** (flattened for each character)
Identify character development phases. Each phase is a separate object with characterId and phaseIndex:
\`\`\`json
{
  "arcPhases": [
    {
      "characterId": "char-1",
      "phaseIndex": 0,
      "phaseName": "Initial state (e.g., 'naive', 'innocent')",
      "arcType": "transformation",
      "triggerEventId": null,
      "stateFacets": ["trusting", "optimistic"]
    },
    {
      "characterId": "char-1",
      "phaseIndex": 1,
      "phaseName": "After transformation (e.g., 'hardened')",
      "arcType": "transformation",
      "triggerEventId": "ev-3",
      "stateFacets": ["cynical", "experienced"]
    }
  ]
}
\`\`\`

COMBINED OUTPUT:
\`\`\`json
{
  "narrativeThreads": [...],
  "arcPhases": [...]
}
\`\`\`

NARRATIVE THREAD RULES:
1. Main plot = isPrimary: true (only one)
2. Subplots, flashbacks = isPrimary: false
3. Use event IDs, not names
4. Events can belong to multiple threads
5. Thread name should capture the storyline essence

ARC PHASE RULES:
1. Only include characters with meaningful development
2. Each phase is a separate entry with characterId and phaseIndex
3. phaseIndex starts at 0 for initial state, increments for each phase
4. triggerEventId = the event that caused the transition TO this state (null for initial state)
5. stateFacets should match extracted state facets when possible
6. arcType describes the overall arc pattern (same for all phases of a character)

ARC TYPES:
- transformation: Fundamental change in character
- growth: Positive development, gaining wisdom/strength
- fall: Negative arc, corruption or loss
- revelation: Character's true nature revealed
- static: Character remains unchanged (anchor for others)`;
    },
  };

interface RefineThreadsInput {
  algorithmicThreads: Array<{
    eventIds: string[];
    eventNames: string[];
  }>;
  documentTitle?: string;
}

/**
 * Simpler prompt for refining algorithmically detected threads.
 * Used when full analysis isn't needed.
 */
export const refineThreadsPrompt: PromptDefinition<RefineThreadsInput> = {
  id: 'stage5-refine-threads',
  version: 1,
  model: 'gemini-2.5-flash',
  description: 'Stage 5: Name and refine algorithmically detected threads',

  build: ({ algorithmicThreads, documentTitle }) => {
    const threadsSection = algorithmicThreads
      .map((t, i) => {
        return `Thread ${i + 1}:
  Events: ${t.eventNames.map((n, j) => `"${n}" [${t.eventIds[j]}]`).join(', ')}`;
      })
      .join('\n\n');

    return `Name these narrative threads detected in "${documentTitle || 'the document'}".

DETECTED THREADS:
${threadsSection}

For each thread, provide:
\`\`\`json
{
  "threads": [
    {
      "index": 0,
      "name": "Descriptive name",
      "isPrimary": true,
      "description": "One sentence summary"
    }
  ]
}
\`\`\`

RULES:
1. One thread should be isPrimary: true (main plot)
2. Names should be concise but descriptive
3. Description should capture what the thread is about`;
  },
};

import type { PromptDefinition } from '../types';

interface AnalyzeInput {
  content: string;
}

export const analyzeTextPrompt: PromptDefinition<AnalyzeInput> = {
  id: 'story-nodes-analyze',
  version: 2,
  model: 'gemini-2.5-flash',
  description:
    'Extract characters, locations, events, concepts, and rich connections from narrative text',

  build: ({
    content,
  }) => `Analyze the following narrative text and extract story elements with rich relationships.

CRITICAL RULES - FOLLOW EXACTLY:

1. **Character descriptions**: MUST focus on physical appearance, personality traits, role, and motivations. DO NOT include plot events or actions they take. Keep relationships separate.

2. **Location descriptions**: MUST describe physical features, atmosphere, and appearance. DO NOT describe events that happen there.

3. **Connections**: Every node MUST have at least one connection. No isolated nodes. No isolated node groups (all nodes must connect into a single graph).

Extract these element types:
- **Characters**: People or sentient beings. Describe their physical appearance first including specific details, then personality, role, and motivations (but not plot events or actions they take).
- **Locations**: Places where events occur. Describe their appearance, key features, atmosphere, significance.
- **Events**: Significant plot actions. Only create for major narrative moments that involve multiple characters/locations or have lasting story impact. Include documentOrder (order of first appearance in the text, starting from 1).
- **Concepts**: Themes, motifs, ideologies, or abstract forces that drive the narrative.
- **Other**: Important story elements (objects, artifacts) that exist independently and contribute meaningfully to the narrative.

For each element provide:
- Concise name
- Brief description (1-4 sentences following the rules above)
- Aliases (for characters, locations, and objects only): Array of specific alternate names, nicknames, or titles (e.g., "Rikki", "the hunter", "NYC"). Do NOT include generic pronouns (he/she/it/they). Leave empty for events and concepts.

**For Events:** Provide eventRanges instead of passages:
- Each range has startMarker and endMarker (exact 5-10 word verbatim phrases from text)
- startMarker: Where this part of the event BEGINS in the narrative
- endMarker: Where this part of the event ENDS in the narrative
- Most events have 1 range. Use multiple ranges only for discontinuous events (e.g., battle interrupted by flashback, then continues)
- Markers must be exact quotes that can be located in the text
- Leave mentions array empty for events

**For all other types (characters, locations, concepts, other):** Provide passages in the mentions array:
- 1-3 Short keywords or phrases (short but EXACT VERBATIM quotes of 3 to 15 words) from the text. These MUST be word-for-word quotes, not paraphrased or summarized. Do not use ellipsis (...) or edit the text. These must be mentions that define the element the most, or are most significant for its character or meaning or role. Must not simply repeat the name or description, though it can optionally augment or support the description. Must be somewhat specific and not so generic that they would match to irrelevant mentions.

For connections, specify the relationship type:

**Layer 2 - Causal/Temporal (include strength 0-1 for causal edges):**
- CAUSES: A directly causes B (necessary and sufficient in context)
- ENABLES: A makes B possible but doesn't guarantee it
- PREVENTS: A blocks B from occurring
- HAPPENS_BEFORE: Temporal ordering ONLY when not captured by text position or causal edges. Use for: flashbacks, time jumps, parallel storylines. Do NOT use for: sequential events in same scene (text position suffices) or events already connected by CAUSES/ENABLES/PREVENTS (temporal order is implied).

**Layer 3 - Structural/Relational:**
- PARTICIPATES_IN: Agent (character/object) was involved in an event
- LOCATED_AT: Entity exists or occurs at a location
- PART_OF: Strict meronymy - component/section of a containing entity (chapter of book, room of building)
- MEMBER_OF: Belongs to group/organization while retaining identity (character in faction)
- POSSESSES: Ownership or control (character owns object, organization controls location)
- CONNECTED_TO: Social/professional connection between agents (replaces KNOWS - use for friendship, family, professional ties)
- OPPOSES: Conflict, antagonism, or opposition between entities
- ABOUT: Entity relates to abstract concept/theme (character embodies theme, event symbolizes idea)
- RELATED_TO: Fallback for relationships that don't fit above types (use sparingly, <5% of edges)

Also identify narrative threads - named storylines or plot threads that group related events:
- name: Short name for the thread (e.g., "Main Plot", "Flashback Sequence", "Subplot: Romance")
- isPrimary: true for the main storyline, false for subplots/flashbacks
- eventNames: names of events belonging to this thread (in order)

Only create nodes for:
- Events that are truly significant to the overall narrative
- Locations that are actually described or mentioned in the text
- Objects that cannot be sufficiently described as part of a character or location
- Concepts that are thematically important

Text to analyze:
${content}`,
};

import type { PromptDefinition } from '../types';

interface AnalyzeInput {
  content: string;
}

export const analyzeTextPrompt: PromptDefinition<AnalyzeInput> = {
  id: 'story-nodes-analyze',
  version: 2,
  model: 'gemini-2.5-flash',
  description: 'Extract characters, locations, events, concepts, and rich connections from narrative text',

  build: ({ content }) => `Analyze the following narrative text and extract story elements with rich relationships.

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
- Passages: 1-3 Short keywords or phrases (short but exact verbatim quotes of 3 to 15 words) from the text. These must be passages that define the element the most, or are most significant for its character or meaning or role. Must not simply repeat the name or description, though it can optionally augment or support the description. Must be somewhat specific and not so generic that they would match to irrelevant passages.

For connections, specify the relationship type using one of these edge types:
- CAUSES: One event directly causes another
- ENABLES: One element makes another possible
- PREVENTS: One element blocks or stops another
- HAPPENS_BEFORE: Temporal ordering between events
- LOCATED_IN: A character or event is situated in a location
- APPEARS_IN: A character appears in an event
- KNOWS: Two characters know each other
- OPPOSES: Two elements are in conflict
- RELATED_TO: General relationship (use sparingly, prefer specific types)

For causal edges (CAUSES, ENABLES, PREVENTS), include a strength value from 0 to 1.

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

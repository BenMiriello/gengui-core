import type { PromptDefinition } from '../types';

interface AnalyzeInput {
  content: string;
}

export const analyzeTextPrompt: PromptDefinition<AnalyzeInput> = {
  id: 'story-nodes-analyze',
  version: 1,
  model: 'gemini-2.0-flash-exp',
  description: 'Extract characters, locations, events, and connections from narrative text',

  build: ({ content }) => `Analyze the following narrative text and extract story elements.

CRITICAL RULES - FOLLOW EXACTLY:

1. **Character descriptions**: MUST focus on physical appearance, personality traits, role, and motivations. DO NOT include plot events or actions they take. Keep relationships separate.

2. **Location descriptions**: MUST describe physical features, atmosphere, and appearance. DO NOT describe events that happen there.

3. **Connections**: Every node MUST have at least one connection. No isolated nodes. No isolated node groups (all nodes must connect into a single graph).

Extract these element types:
- **Characters**: People or sentient beings. Describe their physical appearance first including specific details, then personality, role, and motivations (but not plot events or actions they take).
- **Locations**: Places where events occur. Describe their appearance, key features, atmosphere, significance.
- **Events**: Significant plot actions. Only create for major narrative moments that involve multiple characters/locations or have lasting story impact.
- **Other**: Important story elements (objects, concepts) that exist independently and contribute meaningfully to the narrative.

Only create nodes for:
- Events that are truly significant to the overall narrative
- Locations that are actually described or mentioned in the text
- Objects that cannot be sufficiently described as part of a character or location

For each element provide:
- Concise name
- Brief description (1-4 sentences following the rules above)
- Passages: 1-3 Short keywords or phrases (short but exact verbatim quotes of 3 to 15 words) from the text. These must be passages that define the element the most, or are most significant for its character or meaning or role. Must not simply repeat the name or description, though it can optionally augment or support the description. Must be somewhat specific and not so generic that they would match to irrelevant passages.

Identify connections/relationships between elements with brief descriptions.

Text to analyze:
${content}`,
};

import type { ExistingNode } from '../../types/storyNodes';
import type { PromptDefinition } from '../types';

interface UpdateInput {
  content: string;
  existingNodes: ExistingNode[];
}

export const updateNodesPrompt: PromptDefinition<UpdateInput> = {
  id: 'story-nodes-update',
  version: 2,
  model: 'gemini-2.5-flash',
  description:
    'Analyze document for incremental changes to existing story nodes with rich relationships',

  build: ({ content, existingNodes }) => {
    const existingNodesJson = JSON.stringify(
      existingNodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        description: n.description,
        aliases: n.aliases,
        mentions: n.mentions,
      })),
      null,
      2
    );

    return `You are analyzing a document for INCREMENTAL CHANGES to story elements.

CRITICAL: This is an UPDATE operation, not a fresh analysis. You MUST:
1. Reference existing nodes by their exact ID when updating or deleting
2. Only return CHANGES - do not recreate existing nodes that haven't changed
3. Return empty arrays if there are no changes of that type

DESCRIPTION RULES (for image generation):
- Descriptions must describe the entity IN ISOLATION - what it looks like, its intrinsic characteristics
- DO NOT describe relationships to other entities, actions taken, narrative role, or plot events
- Characters: physical appearance, clothing, expression, demeanor only
- Locations: physical features, architecture, atmosphere, visual details only
- Objects: physical appearance, materials, size, visual details only

WHEN TO MAKE CHANGES:
- ADD: Only if the text describes a NEW character, location, event, concept, or important element not already tracked
- UPDATE: Only if existing node information CONTRADICTS the current text, has SIGNIFICANT NEW INFORMATION, or the element's role/description has meaningfully changed
- DELETE: Only if the element has been REMOVED from the text entirely (not just unmentioned)

DO NOT make changes for:
- Minor wording differences that don't change meaning
- Elements that are simply not mentioned in every passage
- Stylistic preferences or "improvements" to existing descriptions

EXISTING NODES (reference by ID):
${existingNodesJson}

CURRENT DOCUMENT TEXT:
${content}

Return a JSON object with:
- add: Array of new nodes (same format as fresh analysis, including type which can be character/location/event/concept/other, and optional aliases array). For events, include documentOrder.
- update: Array of {id, name?, description?, aliases?, mentions?} - only include fields that changed
- delete: Array of node IDs to remove
- connectionUpdates: {add: [], delete: []} - add uses fromId/toId for existing nodes or fromName/toName for new nodes. Each connection must include edgeType and description. Causal edges (CAUSES, ENABLES, PREVENTS) should include strength (0-1).
  Edge types:
  - Layer 2: CAUSES, ENABLES, PREVENTS, HAPPENS_BEFORE (use HAPPENS_BEFORE only for flashbacks/time jumps/parallel storylines - not for sequential events or events already causally connected)
  - Layer 3: PARTICIPATES_IN (agent in event), LOCATED_AT (at location), PART_OF (meronymy), MEMBER_OF (group membership), POSSESSES (ownership), CONNECTED_TO (social ties, replaces KNOWS), OPPOSES (conflict), ABOUT (entity to concept)
  - Fallback: RELATED_TO (use sparingly)
- narrativeThreads: Array of {name, isPrimary, eventNames} for any new or changed narrative threads

For aliases: For characters, locations, and objects only - provide specific alternate names, nicknames, or titles (e.g., "Rikki", "the hunter", "NYC"). Do NOT include generic pronouns (he/she/it/they). Leave empty for events and concepts.
For mentions: Use short EXACT VERBATIM quotes (3-15 words) that define the element. Do not paraphrase or use ellipsis.`;
  },
};

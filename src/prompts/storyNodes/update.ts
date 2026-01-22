import type { PromptDefinition } from '../types';
import type { ExistingNode } from '../../types/storyNodes';

interface UpdateInput {
  content: string;
  existingNodes: ExistingNode[];
}

export const updateNodesPrompt: PromptDefinition<UpdateInput> = {
  id: 'story-nodes-update',
  version: 1,
  model: 'gemini-2.0-flash-exp',
  description: 'Analyze document for incremental changes to existing story nodes',

  build: ({ content, existingNodes }) => {
    const existingNodesJson = JSON.stringify(
      existingNodes.map(n => ({
        id: n.id,
        type: n.type,
        name: n.name,
        description: n.description,
        passages: n.passages,
      })),
      null,
      2
    );

    return `You are analyzing a document for INCREMENTAL CHANGES to story elements.

CRITICAL: This is an UPDATE operation, not a fresh analysis. You MUST:
1. Reference existing nodes by their exact ID when updating or deleting
2. Only return CHANGES - do not recreate existing nodes that haven't changed
3. Return empty arrays if there are no changes of that type

WHEN TO MAKE CHANGES:
- ADD: Only if the text describes a NEW character, location, event, or important element not already tracked
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
- add: Array of new nodes (same format as fresh analysis)
- update: Array of {id, name?, description?, passages?} - only include fields that changed
- delete: Array of node IDs to remove
- connectionUpdates: {add: [], delete: []} - add uses fromId/toId for existing nodes or fromName/toName for new nodes

For passages: Use short verbatim quotes (3-15 words) that define the element.`;
  },
};

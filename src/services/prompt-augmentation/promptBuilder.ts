/**
 * Pure prompt construction functions - no I/O
 */

/** @deprecated Use EntityReferences instead */
export interface CharacterReferences {
  mode: 'auto' | 'manual';
  selectedNodeIds?: string[];
}

export interface EntityReferences {
  mode: 'auto' | 'manual';
  selectedNodeIds?: string[];
  useImages: boolean;
  useDescriptions: boolean;
}

export interface EntityDescription {
  type: 'character' | 'location' | 'object';
  name: string;
  description: string;
}

export interface PromptEnhancementSettings {
  enabled: boolean;
  charsBefore: number;
  charsAfter: number;
  useNarrativeContext: boolean;
  sceneTreatment: 'comprehensive' | 'focused' | 'selective-detail';
  selectiveDetailFocus?: string;
  strength: 'low' | 'medium' | 'high';
  /** @deprecated Use entityReferences instead */
  characterReferences?: CharacterReferences;
  entityReferences?: EntityReferences;
}

export interface PromptContext {
  storyContext?: string;
  textBefore?: string;
  selectedText: string;
  textAfter?: string;
  entityDescriptions?: EntityDescription[];
}

export function buildGeminiPrompt(
  context: PromptContext,
  settings: PromptEnhancementSettings,
): string {
  const sections: string[] = [
    'You are helping generate an image prompt for a story scene.',
    '',
  ];

  // Add story context if available
  if (context.storyContext) {
    sections.push(context.storyContext);
    sections.push('');
  }

  // Add reference entity descriptions (for Gemini to incorporate naturally)
  if (context.entityDescriptions?.length) {
    sections.push(
      'REFERENCE ENTITIES (incorporate their visual details into the prompt):',
    );
    for (const entity of context.entityDescriptions) {
      const label = entity.type.charAt(0).toUpperCase() + entity.type.slice(1);
      sections.push(`- [${label}] ${entity.name}: ${entity.description}`);
    }
    sections.push('');
  }

  // Add text before if available
  if (context.textBefore) {
    sections.push('TEXT BEFORE SELECTION (for context):');
    sections.push(context.textBefore);
    sections.push('');
  }

  // Add selected text (always included)
  sections.push('SELECTED TEXT TO VISUALIZE:');
  sections.push(context.selectedText);
  sections.push('');

  // Add text after if available
  if (context.textAfter) {
    sections.push('TEXT AFTER SELECTION (for context):');
    sections.push(context.textAfter);
    sections.push('');
  }

  // Add critical instructions
  sections.push('CRITICAL INSTRUCTIONS:');
  sections.push(
    '1. Character/location descriptions from story context show their general state. Use surrounding text to understand their appearance AT THIS SPECIFIC MOMENT.',
  );
  sections.push(
    "2. Events that happen AFTER the selected text do not inform the image. They're included only for scene descriptors.",
  );
  sections.push(
    '3. Focus only on relevant information. Lots of context is provided - assess what matters for THIS moment.',
  );
  sections.push('4. Capture the mood and feel of this moment in the story.');
  sections.push(
    '5. Do NOT specify art style (e.g., painting, anime, realistic). Focus on subject, scene, mood only.',
  );
  sections.push(
    '6. When reference entities are provided, incorporate their visual descriptions naturally into the prompt. Weave appearance details into the scene - do not list them separately.',
  );
  sections.push('');

  // Add scene treatment instructions
  sections.push(
    `SCENE TREATMENT - ${getSceneTreatmentLabel(settings.sceneTreatment)}:`,
  );
  sections.push(getSceneTreatmentInstructions(settings));
  sections.push('');

  // Add strength instructions
  sections.push(`STRENGTH - ${getStrengthLabel(settings.strength)}:`);
  sections.push(getStrengthInstructions(settings.strength));
  sections.push('');

  sections.push(
    'Generate a detailed, vivid image generation prompt. Return ONLY the prompt text, no explanation.',
  );

  return sections.join('\n');
}

export function getSceneTreatmentLabel(treatment: string): string {
  const labels: Record<string, string> = {
    comprehensive: 'Comprehensive',
    focused: 'Focused',
    'selective-detail': 'Selective Detail',
  };
  return labels[treatment] || 'Comprehensive';
}

export function getSceneTreatmentInstructions(
  settings: PromptEnhancementSettings,
): string {
  switch (settings.sceneTreatment) {
    case 'comprehensive':
      return 'Include as many relevant elements as possible: all mentioned characters, objects, setting details, and atmospheric elements.';
    case 'focused':
      return 'Include only essential elements: primary characters, key objects, and main setting. Exclude background details.';
    case 'selective-detail':
      if (settings.selectiveDetailFocus) {
        return `Focus on this specific detail: ${settings.selectiveDetailFocus}. Use close-up framing. Provide enough context but exclude irrelevant elements.`;
      } else {
        return "Select ONE evocative detail from the scene. Use close-up framing. Provide enough context (e.g., 'a weathered hand' not just 'a hand'). Choose something visually striking - a face, object, body part, or scene detail. Vary your selection to keep it interesting.";
      }
    default:
      return 'Include as many relevant elements as possible.';
  }
}

export function getStrengthLabel(strength: string): string {
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
  };
  return labels[strength] || 'Medium';
}

export function getStrengthInstructions(strength: string): string {
  switch (strength) {
    case 'low':
      return "Make minimal adjustments. Clarify ambiguities and add essential visual details only. Preserve the user's original phrasing.";
    case 'medium':
      return 'You may restructure, add vivid descriptors, and remove redundant text. Keep the core subject and scene intact.';
    case 'high':
      return 'Fully rewrite for optimal image generation. Add artistic details, lighting, composition, mood. Preserve only the essential subject, scene, and setting.';
    default:
      return 'You may restructure, add vivid descriptors, and remove redundant text. Keep the core subject and scene intact.';
  }
}

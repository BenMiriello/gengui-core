/**
 * Generation settings for character sheets and other node-based image generation.
 * Versioned for future schema migrations.
 */

export const GENERATION_SETTINGS_SCHEMA_VERSION = 1;

export type CharacterFraming = 'portrait' | 'full_body';
export type PlacePerspective = 'exterior' | 'interior' | 'custom';
export type BackgroundType = 'white' | 'black' | 'transparent' | 'custom';
export type AspectRatio = 'portrait' | 'square' | 'landscape';

export interface CharacterSheetSettings {
  /** For characters: portrait (head/shoulders) or full body */
  framing?: CharacterFraming;

  /** For locations: exterior, interior, or custom view */
  perspective?: PlacePerspective;
  perspectiveCustom?: string;

  /** Background style */
  background: BackgroundType;
  backgroundCustom?: string;

  /** If true, user provided custom description instead of auto-generated */
  manualEdit: boolean;

  /** Custom description (only used if manualEdit=true) */
  customDescription?: string;

  /** Aspect ratio for the generated image */
  aspectRatio?: AspectRatio;
}

export interface GenerationSettingsRecord {
  type: 'character_sheet';
  settings: CharacterSheetSettings;
}

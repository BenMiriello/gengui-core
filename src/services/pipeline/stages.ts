/**
 * Stage definitions and labels for the multi-stage pipeline.
 *
 * Stage 1: Segmentation + Sentence Embeddings (algorithmic)
 * Stage 2: Segment Summarization (LLM, parallel)
 * Stage 3: Entity + Facet Extraction (LLM, multi-segment batching)
 * Stage 4: Text Grounding (algorithmic + embeddings)
 * Stage 5: Entity Resolution (multi-signal batch clustering)
 * Stage 6: Intra-Segment Relationships (LLM, parallel per segment)
 * Stage 7: Cross-Segment Relationships (LLM, sequential)
 * Stage 8: Higher-Order Analysis (LLM + algorithmic)
 * Stage 9: CharacterState Facet Attachment (algorithmic)
 * Stage 10: Conflict Detection (algorithmic)
 */

export type AnalysisStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Complete stage metadata for frontend rendering and progress tracking.
 */
export interface StageInfo {
  number: AnalysisStage;
  name: string;
  description: string;
  genericLabel: string;
  technicalLabel: string;
}

export const ANALYSIS_STAGES: StageInfo[] = [
  {
    number: 1,
    name: 'Segmentation',
    description: 'Dividing document into segments and generating embeddings',
    genericLabel: 'Reading through document...',
    technicalLabel: 'Stage 1: Segmentation + Sentence Embeddings',
  },
  {
    number: 2,
    name: 'Segment Summarization',
    description: 'Generating summaries for all segments',
    genericLabel: 'Summarizing segments...',
    technicalLabel: 'Stage 2: Segment Summarization',
  },
  {
    number: 3,
    name: 'Entity Extraction',
    description: 'Identifying characters, locations, events, and concepts',
    genericLabel: 'Identifying characters, places, and ideas...',
    technicalLabel: 'Stage 3: Entity + Facet Extraction',
  },
  {
    number: 4,
    name: 'Text Grounding',
    description: 'Linking entities to specific text positions',
    genericLabel: 'Connecting entities to text...',
    technicalLabel: 'Stage 4: Text Grounding',
  },
  {
    number: 5,
    name: 'Entity Resolution',
    description: 'Creating nodes in knowledge graph and resolving duplicates',
    genericLabel: 'Connecting aliases and resolving identities...',
    technicalLabel: 'Stage 5: Entity Resolution',
  },
  {
    number: 6,
    name: 'Intra-Segment Relationships',
    description: 'Finding connections within scenes',
    genericLabel: 'Mapping connections...',
    technicalLabel: 'Stage 6: Intra-Segment Relationships',
  },
  {
    number: 7,
    name: 'Cross-Segment Relationships',
    description: 'Connecting entities across scenes',
    genericLabel: 'Finding connections across the story...',
    technicalLabel: 'Stage 7: Cross-Segment Relationships',
  },
  {
    number: 8,
    name: 'Higher-Order Analysis',
    description: 'Detecting narrative structure, threads, and character arcs',
    genericLabel: 'Finding narrative arcs and themes...',
    technicalLabel: 'Stage 8: Higher-Order Analysis',
  },
  {
    number: 9,
    name: 'Character State',
    description: 'Tracking character state transitions',
    genericLabel: 'Organizing character states...',
    technicalLabel: 'Stage 9: CharacterState Facet Attachment',
  },
  {
    number: 10,
    name: 'Conflict Detection',
    description: 'Identifying contradictions in the narrative',
    genericLabel: 'Checking for inconsistencies...',
    technicalLabel: 'Stage 10: Conflict Detection',
  },
];

export const TOTAL_STAGES = ANALYSIS_STAGES.length;

export function getStageInfo(stage: AnalysisStage): StageInfo | undefined {
  return ANALYSIS_STAGES.find((s) => s.number === stage);
}

/**
 * @deprecated Use getStageInfo instead
 */
export const STAGE_LABELS: Record<
  AnalysisStage,
  { generic: string; technical: string }
> = {
  1: {
    generic: 'Reading through document...',
    technical: 'Stage 1: Segmentation + Sentence Embeddings',
  },
  2: {
    generic: 'Summarizing segments...',
    technical: 'Stage 2: Segment Summarization',
  },
  3: {
    generic: 'Identifying characters, places, and ideas...',
    technical: 'Stage 3: Entity + Facet Extraction',
  },
  4: {
    generic: 'Connecting entities to text...',
    technical: 'Stage 4: Text Grounding',
  },
  5: {
    generic: 'Connecting aliases and resolving identities...',
    technical: 'Stage 5: Entity Resolution',
  },
  6: {
    generic: 'Mapping connections...',
    technical: 'Stage 6: Intra-Segment Relationships',
  },
  7: {
    generic: 'Finding connections across the story...',
    technical: 'Stage 7: Cross-Segment Relationships',
  },
  8: {
    generic: 'Finding narrative arcs and themes...',
    technical: 'Stage 8: Higher-Order Analysis',
  },
  9: {
    generic: 'Organizing character states...',
    technical: 'Stage 9: CharacterState Facet Attachment',
  },
  10: {
    generic: 'Checking for inconsistencies...',
    technical: 'Stage 10: Conflict Detection',
  },
};

/**
 * @deprecated Use getStageInfo instead
 */
export function getStageLabel(stage: AnalysisStage, technical = false): string {
  return technical
    ? STAGE_LABELS[stage].technical
    : STAGE_LABELS[stage].generic;
}

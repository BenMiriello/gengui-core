/**
 * Stage definitions and labels for the multi-stage pipeline.
 *
 * Stage 1: Segmentation + Sentence Embeddings (algorithmic)
 * Stage 2: Segment Summarization (LLM, parallel)
 * Stage 3: Entity + Facet Extraction (LLM, multi-segment batching)
 * Stage 4: Entity Resolution (multi-signal batch clustering)
 * Stage 5: Intra-Segment Relationships (LLM, parallel per segment)
 * Stage 6: Cross-Segment Relationships (LLM, sequential)
 * Stage 7: Higher-Order Analysis (LLM + algorithmic)
 * Stage 8: Arc State Facet Attachment (algorithmic)
 * Stage 9: Conflict Detection (LLM batch analysis)
 */

export type AnalysisStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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
    name: 'Entity Resolution',
    description: 'Creating nodes in knowledge graph and resolving duplicates',
    genericLabel: 'Connecting aliases and resolving identities...',
    technicalLabel: 'Stage 4: Entity Resolution',
  },
  {
    number: 5,
    name: 'Intra-Segment Relationships',
    description: 'Finding connections within scenes',
    genericLabel: 'Mapping connections...',
    technicalLabel: 'Stage 5: Intra-Segment Relationships',
  },
  {
    number: 6,
    name: 'Cross-Segment Relationships',
    description: 'Connecting entities across scenes',
    genericLabel: 'Finding connections across the story...',
    technicalLabel: 'Stage 6: Cross-Segment Relationships',
  },
  {
    number: 7,
    name: 'Higher-Order Analysis',
    description: 'Detecting narrative structure, threads, and character arcs',
    genericLabel: 'Finding narrative arcs and themes...',
    technicalLabel: 'Stage 7: Higher-Order Analysis',
  },
  {
    number: 8,
    name: 'Arc State',
    description: 'Tracking arc state transitions',
    genericLabel: 'Organizing arc states...',
    technicalLabel: 'Stage 8: Arc State Facet Attachment',
  },
  {
    number: 9,
    name: 'Conflict Detection',
    description: 'Identifying contradictions in the narrative',
    genericLabel: 'Checking for inconsistencies...',
    technicalLabel: 'Stage 9: Conflict Detection',
  },
];

export const TOTAL_STAGES = ANALYSIS_STAGES.length;

export function getStageInfo(stage: AnalysisStage): StageInfo | undefined {
  return ANALYSIS_STAGES.find((s) => s.number === stage);
}

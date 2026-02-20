/**
 * Stage definitions and labels for the multi-stage pipeline.
 */

export type AnalysisStage = 0 | 1 | 2 | 3 | 4 | '4b' | 5;

export const STAGE_LABELS: Record<AnalysisStage, { generic: string; technical: string }> = {
  0: {
    generic: 'Reading through your document...',
    technical: 'Stage 0: Segmentation + Sentence Embeddings',
  },
  1: {
    generic: 'Identifying characters, places, and key ideas...',
    technical: 'Stage 1: Entity + Facet Extraction',
  },
  2: {
    generic: 'Finding where each entity appears...',
    technical: 'Stage 2: Text Grounding',
  },
  3: {
    generic: 'Connecting aliases and resolving identities...',
    technical: 'Stage 3: Entity Resolution',
  },
  4: {
    generic: 'Mapping how everything connects...',
    technical: 'Stage 4: Relationship Extraction',
  },
  '4b': {
    generic: 'Finding connections across the story...',
    technical: 'Stage 4b: Cross-Segment Relationships',
  },
  5: {
    generic: 'Spotting narrative arcs and themes...',
    technical: 'Stage 5: Higher-Order Analysis',
  },
};

export function getStageLabel(stage: AnalysisStage, technical = false): string {
  return technical ? STAGE_LABELS[stage].technical : STAGE_LABELS[stage].generic;
}

/**
 * Stage definitions and labels for the multi-stage pipeline.
 *
 * Stage 1: Segmentation + Sentence Embeddings (algorithmic)
 * Stage 2: Entity + Facet Extraction (LLM, parallel per segment)
 * Stage 3: Text Grounding (algorithmic + embeddings)
 * Stage 4: Entity Resolution (multi-signal batch clustering)
 * Stage 5: Intra-Segment Relationships (LLM, parallel per segment)
 * Stage 6: Cross-Segment Relationships (LLM, sequential)
 * Stage 7: Higher-Order Analysis (LLM + algorithmic)
 */

export type AnalysisStage = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const STAGE_LABELS: Record<
  AnalysisStage,
  { generic: string; technical: string }
> = {
  1: {
    generic: 'Reading through your document...',
    technical: 'Stage 1: Segmentation + Sentence Embeddings',
  },
  2: {
    generic: 'Identifying characters, places, and key ideas...',
    technical: 'Stage 2: Entity + Facet Extraction',
  },
  3: {
    generic: 'Finding where each entity appears...',
    technical: 'Stage 3: Text Grounding',
  },
  4: {
    generic: 'Connecting aliases and resolving identities...',
    technical: 'Stage 4: Entity Resolution',
  },
  5: {
    generic: 'Mapping how everything connects...',
    technical: 'Stage 5: Intra-Segment Relationships',
  },
  6: {
    generic: 'Finding connections across the story...',
    technical: 'Stage 6: Cross-Segment Relationships',
  },
  7: {
    generic: 'Spotting narrative arcs and themes...',
    technical: 'Stage 7: Higher-Order Analysis',
  },
};

export function getStageLabel(stage: AnalysisStage, technical = false): string {
  return technical
    ? STAGE_LABELS[stage].technical
    : STAGE_LABELS[stage].generic;
}

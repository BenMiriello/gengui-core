/**
 * Shared types for analysis service integration — used by the completion
 * stream consumer and the reconciliation-on-load flow.
 */

export interface AnalysisEntityMention {
  segment_id: string;
  text: string;
  start: number | null;
  end: number | null;
}

export interface AnalysisEntity {
  id: string;
  mentions?: AnalysisEntityMention[];
}

/**
 * Types for staleness detection service.
 */

export interface SentenceHash {
  index: number;
  start: number;
  end: number;
  hash: string;
}

export interface StaleRegion {
  charStart: number;
  charEnd: number;
  sentenceIndex: number;
  changeType: 'changed';
}

export interface StalenessResult {
  staleRegions: StaleRegion[];
  sentenceCount: number;
  changedSentenceCount: number;
  lastAnalyzedVersion: number | null;
}

export interface AnalysisSnapshotInput {
  documentId: string;
  versionNumber: number;
  sentences: Array<{
    index: number;
    start: number;
    end: number;
    hash: string;
  }>;
}

/**
 * Types for sentence embedding service.
 */

export interface Sentence {
  /** Segment-relative start position */
  start: number;
  /** Segment-relative end position */
  end: number;
  /** The sentence text */
  text: string;
  /** SHA-256 hash of content for caching */
  contentHash: string;
}

export interface SentenceWithEmbedding extends Sentence {
  embedding: number[];
}

export interface StoredSentenceEmbedding {
  id: string;
  documentId: string;
  segmentId: string;
  sentenceStart: number;
  sentenceEnd: number;
  contentHash: string;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SentenceSimilarityResult {
  sentenceId: string;
  segmentId: string;
  sentenceStart: number;
  sentenceEnd: number;
  text?: string;
  score: number;
}

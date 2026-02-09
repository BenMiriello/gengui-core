/**
 * Types for the mentions system.
 * Mentions link graph nodes to specific text positions in documents.
 */

export interface Mention {
  id: string;
  nodeId: string;
  documentId: string;
  segmentId: string;
  relativeStart: number;
  relativeEnd: number;
  originalText: string;
  textHash: string;
  confidence: number;
  versionNumber: number;
  source: MentionSource;
  isKeyPassage: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type MentionSource =
  | 'extraction' // LLM-extracted key passages
  | 'name_match' // Algorithmic name/alias matching
  | 'reference' // NLP reference resolution (pronouns, "the Count")
  | 'semantic'; // Embedding similarity (future)

export interface CreateMentionInput {
  nodeId: string;
  documentId: string;
  segmentId: string;
  relativeStart: number;
  relativeEnd: number;
  originalText: string;
  versionNumber: number;
  source: MentionSource;
  confidence?: number;
}

export interface MentionWithAbsolutePosition extends Mention {
  absoluteStart: number;
  absoluteEnd: number;
}

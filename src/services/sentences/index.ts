/**
 * Sentences module - sentence-level embeddings for semantic search.
 */

export { computeContentHash, splitIntoSentences } from './sentence.detector';
export { sentenceService } from './sentence.service';
export type {
  Sentence,
  SentenceSimilarityResult,
  SentenceWithEmbedding,
  StoredSentenceEmbedding,
} from './sentence.types';

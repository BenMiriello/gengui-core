/**
 * Sentences module - sentence-level embeddings for semantic search.
 */

export { sentenceService } from './sentence.service';
export { splitIntoSentences, computeContentHash } from './sentence.detector';
export type {
  Sentence,
  SentenceWithEmbedding,
  StoredSentenceEmbedding,
  SentenceSimilarityResult,
} from './sentence.types';

/**
 * Entity Resolution Service
 *
 * NOTE: As of v2, the pipeline uses LLM-first merge detection.
 * This module is now primarily used for:
 * - Embedding similarity calculation (for candidate selection)
 * - Incremental updates (non-pipeline entity resolution)
 * - Legacy support for older code paths
 *
 * For new extraction, see pipeline.ts Stage 2 which uses
 * LLM merge detection via extractEntitiesFromSegment().
 */

// Alias patterns
export {
  computeAliasPatternScore,
  ensurePhoneticReady,
  extractEpithet,
  extractTitle,
  generateAliasVariants,
  getNameTokens,
  getPhoneticCodes,
  isLikelyEpithet,
  isSubstringMatch,
  normalizeNameForMatching,
  phoneticMatch,
  shareTitle,
  tokenOverlap,
} from './aliasPatterns';
// Blocking
export {
  type BlockingIndex,
  buildBlockingIndex,
  filterByBlocking,
  getBlockingStats,
  getCandidateIds,
} from './blocking';
// Clustering
export {
  clusterAcrossSegments,
  clusterBySegment,
  clusterToCandidate,
  clusterWithinSegment,
} from './clustering';
// Main resolver
export {
  getResolutionCandidates,
  mapToLegacyDecision,
  type ResolveResult,
  type ResolverOptions,
  resolveEntities,
} from './resolver';

// Scoring
export {
  computeConfidence,
  computeSignalBreakdown,
  computeWeightedScore,
  cosineSimilarity,
  type GraphContext,
  scoreCandidate,
  scoreCandidates,
  scoreEmbeddingSimilarity,
  scoreGraphContext,
  scoreNameSimilarity,
  scoreTypeMatch,
} from './scoring';

// Thresholding
export {
  batchResolve,
  makeDecision,
  needsLLMRefinement,
  resolveCluster,
  resolveFromScores,
  summarizeDecision,
} from './thresholding';
// Types
export type {
  ClusterResolutionResult,
  EntityCandidate,
  EntityCluster,
  ExistingEntity,
  ResolutionConfig,
  ResolutionDecision,
  ResolutionResult,
  ResolutionThresholds,
  ScoredCandidate,
  SignalBreakdown,
  SignalWeights,
} from './types';
export {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  WEIGHTS_BY_TYPE,
} from './types';

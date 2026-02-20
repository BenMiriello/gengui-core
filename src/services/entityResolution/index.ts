/**
 * Entity Resolution Service
 *
 * Multi-signal batch clustering for entity resolution.
 * Replaces per-entity LLM calls with algorithmic clustering.
 *
 * Key features:
 * - Multi-signal scoring (embedding, name, type, graph context)
 * - Within-segment clustering (merge aliases before graph resolution)
 * - Three-tier thresholding (auto-merge, review, create)
 * - Confidence scoring for borderline cases
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

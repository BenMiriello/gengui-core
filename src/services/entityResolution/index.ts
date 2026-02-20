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

// Types
export type {
  EntityCandidate,
  EntityCluster,
  ExistingEntity,
  ResolutionResult,
  ClusterResolutionResult,
  SignalBreakdown,
  ScoredCandidate,
  ResolutionConfig,
  ResolutionThresholds,
  SignalWeights,
  ResolutionDecision,
} from './types';

export {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  WEIGHTS_BY_TYPE,
} from './types';

// Main resolver
export {
  resolveEntities,
  getResolutionCandidates,
  mapToLegacyDecision,
  type ResolverOptions,
  type ResolveResult,
} from './resolver';

// Clustering
export {
  clusterWithinSegment,
  clusterBySegment,
  clusterAcrossSegments,
  clusterToCandidate,
} from './clustering';

// Scoring
export {
  cosineSimilarity,
  scoreEmbeddingSimilarity,
  scoreNameSimilarity,
  scoreTypeMatch,
  scoreGraphContext,
  computeSignalBreakdown,
  computeWeightedScore,
  computeConfidence,
  scoreCandidate,
  scoreCandidates,
  type GraphContext,
} from './scoring';

// Thresholding
export {
  makeDecision,
  resolveFromScores,
  resolveCluster,
  batchResolve,
  needsLLMRefinement,
  summarizeDecision,
} from './thresholding';

// Alias patterns
export {
  normalizeNameForMatching,
  extractTitle,
  extractEpithet,
  getNameTokens,
  tokenOverlap,
  isSubstringMatch,
  shareTitle,
  isLikelyEpithet,
  generateAliasVariants,
  computeAliasPatternScore,
  phoneticMatch,
  getPhoneticCodes,
  ensurePhoneticReady,
} from './aliasPatterns';

// Blocking
export {
  buildBlockingIndex,
  getCandidateIds,
  filterByBlocking,
  getBlockingStats,
  type BlockingIndex,
} from './blocking';

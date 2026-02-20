/**
 * Multi-Signal Scoring for Entity Resolution
 *
 * Combines multiple signals to score entity similarity:
 * - Embedding similarity (semantic meaning)
 * - Name similarity (string matching)
 * - Type match (entity type)
 * - Graph context (co-occurrence patterns)
 */

import {
  type SignalBreakdown,
  type SignalWeights,
  type EntityCandidate,
  type ExistingEntity,
  type ScoredCandidate,
  WEIGHTS_BY_TYPE,
  DEFAULT_WEIGHTS,
} from './types';
import {
  normalizeNameForMatching,
  tokenOverlap,
  isSubstringMatch,
  computeAliasPatternScore,
  phoneticMatch,
} from './aliasPatterns';

// ========== Embedding Similarity ==========

/**
 * Compute cosine similarity between two embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Score embedding similarity between candidate and existing entity.
 * Returns normalized score [0, 1].
 */
export function scoreEmbeddingSimilarity(
  candidate: EntityCandidate,
  existing: ExistingEntity
): number {
  if (!existing.embedding || existing.embedding.length === 0) {
    return 0;
  }
  return Math.max(0, cosineSimilarity(candidate.embedding, existing.embedding));
}

// ========== Name Similarity ==========

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

/**
 * Compute normalized Levenshtein similarity [0, 1].
 */
function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Score name similarity using multiple strategies.
 * Returns the best match score across all strategies.
 *
 * Strategies:
 * - Exact match (normalized)
 * - Substring containment
 * - Phonetic match (Double Metaphone)
 * - Token overlap (Jaccard)
 * - Levenshtein similarity
 * - Alias pattern matching
 */
export function scoreNameSimilarity(
  candidateName: string,
  existingName: string,
  existingAliases?: string[]
): number {
  const namesToCheck = [existingName, ...(existingAliases || [])];
  let bestScore = 0;

  for (const name of namesToCheck) {
    const norm1 = normalizeNameForMatching(candidateName);
    const norm2 = normalizeNameForMatching(name);

    // Exact match after normalization
    if (norm1 === norm2) {
      return 1.0;
    }

    // Substring match
    if (isSubstringMatch(candidateName, name)) {
      bestScore = Math.max(bestScore, 0.9);
      continue;
    }

    // Phonetic match (catches spelling variations like Dracula/Drakula)
    if (phoneticMatch(candidateName, name)) {
      bestScore = Math.max(bestScore, 0.85);
    }

    // Alias pattern score
    const aliasScore = computeAliasPatternScore(candidateName, name);
    bestScore = Math.max(bestScore, aliasScore);

    // Token overlap (Jaccard)
    const tokenScore = tokenOverlap(candidateName, name);
    bestScore = Math.max(bestScore, tokenScore * 0.8);

    // Levenshtein similarity
    const levScore = levenshteinSimilarity(norm1, norm2);
    bestScore = Math.max(bestScore, levScore * 0.7);
  }

  return Math.min(1, bestScore);
}

// ========== Type Matching ==========

/**
 * Score type match between candidate and existing entity.
 */
export function scoreTypeMatch(
  candidateType: string,
  existingType: string
): number {
  if (candidateType === existingType) return 1.0;

  // Compatible types (character and character_state)
  if (
    (candidateType === 'character' && existingType === 'character_state') ||
    (candidateType === 'character_state' && existingType === 'character')
  ) {
    return 0.8;
  }

  return 0;
}

// ========== Graph Context ==========

export interface GraphContext {
  segmentIds: string[];
  neighborEntityIds: string[];
}

/**
 * Score graph context similarity.
 * Considers segment co-occurrence and shared neighbors.
 *
 * NOOP: Graph edges don't exist until Stage 4 (after resolution).
 * Only useful for incremental re-analysis. Uncomment when wiring up getGraphContext.
 */
export function scoreGraphContext(
  candidateContext: GraphContext,
  existingContext: GraphContext
): number {
  // NOOP until incremental analysis is wired up
  return 0;

  // Segment overlap
  const candidateSegments = new Set(candidateContext.segmentIds);
  const existingSegments = new Set(existingContext.segmentIds);

  let segmentOverlap = 0;
  for (const s of candidateSegments) {
    if (existingSegments.has(s)) segmentOverlap++;
  }

  const segmentUnion = new Set([...candidateSegments, ...existingSegments]);
  const segmentScore =
    segmentUnion.size > 0 ? segmentOverlap / segmentUnion.size : 0;

  // Neighbor overlap
  const candidateNeighbors = new Set(candidateContext.neighborEntityIds);
  const existingNeighbors = new Set(existingContext.neighborEntityIds);

  let neighborOverlap = 0;
  for (const n of candidateNeighbors) {
    if (existingNeighbors.has(n)) neighborOverlap++;
  }

  const neighborUnion = new Set([...candidateNeighbors, ...existingNeighbors]);
  const neighborScore =
    neighborUnion.size > 0 ? neighborOverlap / neighborUnion.size : 0;

  // Combine scores (segment overlap is more important)
  return segmentScore * 0.6 + neighborScore * 0.4;
}

// ========== Combined Scoring ==========

/**
 * Compute full signal breakdown for a candidate pair.
 */
export function computeSignalBreakdown(
  candidate: EntityCandidate,
  existing: ExistingEntity,
  candidateGraphContext?: GraphContext,
  existingGraphContext?: GraphContext
): SignalBreakdown {
  return {
    embedding: scoreEmbeddingSimilarity(candidate, existing),
    name: scoreNameSimilarity(candidate.name, existing.name, existing.aliases),
    type: scoreTypeMatch(candidate.type, existing.type),
    graph:
      candidateGraphContext && existingGraphContext
        ? scoreGraphContext(candidateGraphContext, existingGraphContext)
        : 0,
  };
}

/**
 * Compute weighted score from signal breakdown.
 */
export function computeWeightedScore(
  signals: SignalBreakdown,
  weights: SignalWeights
): number {
  return (
    signals.embedding * weights.embedding +
    signals.name * weights.name +
    signals.type * weights.type +
    signals.graph * weights.graph
  );
}

/**
 * Compute confidence based on signal agreement.
 * High confidence when signals agree, low when they conflict.
 */
export function computeConfidence(signals: SignalBreakdown): number {
  const values = [signals.embedding, signals.name, signals.type, signals.graph];
  const nonZeroValues = values.filter((v) => v > 0);

  if (nonZeroValues.length === 0) return 0;

  // Compute variance of non-zero signals
  const mean = nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length;
  const variance =
    nonZeroValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    nonZeroValues.length;

  // Lower variance = higher confidence
  // Max variance is 0.25 (e.g., [0, 1])
  const normalizedVariance = Math.min(variance / 0.25, 1);
  return 1 - normalizedVariance;
}

/**
 * Score a candidate against an existing entity.
 */
export function scoreCandidate(
  candidate: EntityCandidate,
  existing: ExistingEntity,
  candidateGraphContext?: GraphContext,
  existingGraphContext?: GraphContext
): ScoredCandidate {
  const signals = computeSignalBreakdown(
    candidate,
    existing,
    candidateGraphContext,
    existingGraphContext
  );

  const weights = WEIGHTS_BY_TYPE[candidate.type] || DEFAULT_WEIGHTS;
  const score = computeWeightedScore(signals, weights);
  const confidence = computeConfidence(signals);

  return {
    entity: existing,
    score,
    signals,
    confidence,
  };
}

/**
 * Score a candidate against multiple existing entities.
 * Returns scored candidates sorted by score (descending).
 */
export function scoreCandidates(
  candidate: EntityCandidate,
  existingEntities: ExistingEntity[],
  getGraphContext?: (
    entityId: string
  ) => Promise<GraphContext> | GraphContext | undefined
): ScoredCandidate[] {
  const candidateContext: GraphContext = {
    segmentIds: candidate.mentions
      .map((m) => m.segmentId)
      .filter((s): s is string => s !== undefined),
    neighborEntityIds: [],
  };

  const scored: ScoredCandidate[] = [];

  for (const existing of existingEntities) {
    const existingContext = getGraphContext?.(existing.id);
    const resolvedContext =
      existingContext instanceof Promise ? undefined : existingContext;

    scored.push(
      scoreCandidate(candidate, existing, candidateContext, resolvedContext)
    );
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Three-Tier Thresholding for Entity Resolution
 *
 * Routes resolution decisions based on score and confidence:
 * - Auto-merge (>0.85): High confidence, proceed automatically
 * - Review queue (0.5-0.85): Uncertain, may need LLM refinement
 * - Create new (<0.5): Low similarity, likely different entities
 */

import type {
  ClusterResolutionResult,
  EntityCluster,
  ResolutionResult,
  ResolutionThresholds,
  ScoredCandidate,
  SignalBreakdown,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';

/**
 * Veto threshold: if any key signal is below this value,
 * block auto-merge even if overall score is high.
 */
const VETO_THRESHOLD = 0.3;

/**
 * Check if any signal vetoes the merge.
 * Returns veto reason or null if no veto.
 */
function checkSignalVeto(
  signals: SignalBreakdown,
  score: number,
): string | null {
  if (score < 0.7) return null;

  if (signals.name < VETO_THRESHOLD) {
    return `Name mismatch (${signals.name.toFixed(2)}) despite high overall score`;
  }

  if (signals.type < VETO_THRESHOLD && signals.type > 0) {
    return `Type mismatch (${signals.type.toFixed(2)}) despite high overall score`;
  }

  return null;
}

/**
 * Make a resolution decision based on score and thresholds.
 */
export function makeDecision(
  scoredCandidate: ScoredCandidate | null,
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS,
): ResolutionResult {
  if (!scoredCandidate || scoredCandidate.score < thresholds.review) {
    return {
      decision: 'CREATE',
      score: scoredCandidate?.score ?? 0,
      signals: scoredCandidate?.signals,
      confidence: 0,
      reason: 'No candidates above review threshold',
    };
  }

  const { score, signals, confidence, entity } = scoredCandidate;

  // Check for signal disagreement veto
  const vetoReason = checkSignalVeto(signals, score);
  if (vetoReason) {
    return {
      decision: 'CREATE',
      score,
      signals,
      confidence,
      reason: vetoReason,
    };
  }

  if (score >= thresholds.autoMerge) {
    return {
      decision: 'MERGE',
      targetId: entity.id,
      score,
      signals,
      confidence,
      reason: `High score (${score.toFixed(3)}) above auto-merge threshold`,
    };
  }

  // In the review range (0.5 - 0.85)
  // High confidence + good score = auto-merge
  // Low confidence = review (signals conflict)
  if (confidence > 0.7 && score > 0.65) {
    return {
      decision: 'MERGE',
      targetId: entity.id,
      score,
      signals,
      confidence,
      reason: `Moderate score (${score.toFixed(3)}) with high confidence (${confidence.toFixed(2)})`,
    };
  }

  return {
    decision: 'REVIEW',
    targetId: entity.id,
    score,
    signals,
    confidence,
    reason: `Score (${score.toFixed(3)}) in review range with confidence ${confidence.toFixed(2)}`,
  };
}

/**
 * Process scored candidates and return the best resolution.
 */
export function resolveFromScores(
  scoredCandidates: ScoredCandidate[],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS,
): ResolutionResult {
  if (scoredCandidates.length === 0) {
    return {
      decision: 'CREATE',
      score: 0,
      confidence: 0,
      reason: 'No candidates found',
    };
  }

  // Get best candidate
  const best = scoredCandidates[0];
  return makeDecision(best, thresholds);
}

/**
 * Resolve a cluster against existing entities.
 */
export function resolveCluster(
  cluster: EntityCluster,
  scoredCandidates: ScoredCandidate[],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS,
): ClusterResolutionResult {
  const result = resolveFromScores(scoredCandidates, thresholds);

  return {
    ...result,
    cluster,
    newFacets:
      result.decision === 'MERGE' || result.decision === 'REVIEW'
        ? cluster.mergedFacets
        : undefined,
  };
}

/**
 * Batch resolve multiple clusters.
 */
export function batchResolve(
  clusters: EntityCluster[],
  scoredCandidatesPerCluster: ScoredCandidate[][],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS,
): ClusterResolutionResult[] {
  return clusters.map((cluster, i) =>
    resolveCluster(cluster, scoredCandidatesPerCluster[i] || [], thresholds),
  );
}

/**
 * Check if a resolution needs LLM refinement.
 */
export function needsLLMRefinement(
  result: ResolutionResult,
  llmScoreRange: { min: number; max: number } = { min: 0.5, max: 0.85 },
): boolean {
  if (result.decision !== 'REVIEW') return false;

  // Use LLM when:
  // 1. Score is in the specified range
  // 2. Confidence is low (signals conflict)
  const inRange =
    result.score >= llmScoreRange.min && result.score <= llmScoreRange.max;
  const lowConfidence = result.confidence < 0.6;

  return inRange && lowConfidence;
}

/**
 * Get a human-readable summary of the resolution decision.
 */
export function summarizeDecision(result: ResolutionResult): string {
  const { decision, score, confidence, signals } = result;

  const signalSummary = signals
    ? `emb=${signals.embedding.toFixed(2)}, name=${signals.name.toFixed(2)}, type=${signals.type.toFixed(2)}, graph=${signals.graph.toFixed(2)}`
    : 'no signals';

  switch (decision) {
    case 'MERGE':
      return `MERGE (score=${score.toFixed(3)}, conf=${confidence.toFixed(2)}, ${signalSummary})`;
    case 'REVIEW':
      return `REVIEW (score=${score.toFixed(3)}, conf=${confidence.toFixed(2)}, ${signalSummary})`;
    case 'CREATE':
      return `CREATE (score=${score.toFixed(3)}, ${signalSummary})`;
  }
}

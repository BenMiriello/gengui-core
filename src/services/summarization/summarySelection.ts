/**
 * Budget-aware summary selection for extraction context.
 * Uses priority algorithm with no hard thresholds.
 */

import { logger } from '../../utils/logger';
import type { Segment } from '../segments/segment.types';
import { CONFIG } from './config';

export interface SegmentSummary {
  segment: Segment;
  index: number;
}

export interface SummarySelectionConfig {
  currentBatchIndices: number[];
  allSegments: Segment[];
  availableTokens: number;
  tokensPerSummary?: number;
}

/**
 * Select summaries that fit in token budget, prioritized by relevance.
 * No hard thresholds - naturally scales with document size and budget.
 */
export function selectSummariesForContext(
  config: SummarySelectionConfig,
): Segment[] {
  const {
    currentBatchIndices,
    allSegments,
    availableTokens,
    tokensPerSummary = CONFIG.tokensPerSummary,
  } = config;

  // Calculate max summaries that fit in budget
  const maxSummaries = Math.floor(availableTokens / tokensPerSummary);

  if (maxSummaries <= 0) {
    logger.warn(
      { availableTokens, tokensPerSummary },
      'Insufficient token budget for summaries',
    );
    return [];
  }

  const currentIndex = currentBatchIndices[0];

  // Calculate priority for each segment with summary
  const scored = allSegments
    .map((seg, index) => ({ segment: seg, index }))
    .filter(({ segment }) => segment.summary) // Only include segments with summaries
    .map(({ segment, index }) => ({
      segment,
      index,
      priority: calculateSummaryPriority(
        index,
        currentIndex,
        allSegments.length,
      ),
    }));

  if (scored.length === 0) {
    logger.warn('No segments have summaries available');
    return [];
  }

  // Sort by priority, take what fits in budget
  scored.sort((a, b) => b.priority - a.priority);
  const selected = scored.slice(0, maxSummaries);

  // Restore chronological order
  selected.sort((a, b) => a.index - b.index);

  // Calculate actual token usage
  const totalTokens = selected.length * tokensPerSummary;
  const utilizationPct = (totalTokens / availableTokens) * 100;

  logger.info(
    {
      totalSegments: allSegments.length,
      segmentsWithSummaries: scored.length,
      selectedSummaries: selected.length,
      budgetTokens: availableTokens,
      usedTokens: totalTokens,
      utilizationPct: utilizationPct.toFixed(1),
      selectionRange:
        selected.length > 0
          ? `${selected[0].index}-${selected[selected.length - 1].index}`
          : 'none',
    },
    'Summary selection complete',
  );

  return selected.map((s) => s.segment);
}

/**
 * Calculate priority for a segment summary based on position.
 * Higher priority = more relevant to current extraction batch.
 *
 * Algorithm:
 * - Recency (40%): segments near current position most relevant
 * - Early context (30%): first 5 segments provide setup
 * - Middle decay (30%): exponential decay for distant segments
 */
function calculateSummaryPriority(
  segmentIndex: number,
  currentIndex: number,
  totalSegments: number,
): number {
  const weights = CONFIG.priorityWeights;
  const distance = Math.abs(segmentIndex - currentIndex);
  const relativeDistance = distance / totalSegments;

  // Recency: exponential decay based on distance
  const recencyScore = Math.exp(-relativeDistance * 3) * weights.recency;

  // Early segments: linear decay from first 5 segments
  const earlyScore =
    segmentIndex < 5 ? ((5 - segmentIndex) / 5) * weights.early : 0;

  // Middle segments: gentle exponential decay
  const middleScore =
    segmentIndex >= 5 && segmentIndex < currentIndex - 3
      ? Math.exp(-distance / 20) * weights.middle
      : 0;

  return recencyScore + earlyScore + middleScore;
}

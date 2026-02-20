/**
 * Entity Resolution Orchestrator
 *
 * Main entry point for entity resolution.
 * Coordinates clustering, scoring, and thresholding.
 */

import type {
  EntityCandidate,
  EntityCluster,
  ExistingEntity,
  ResolutionConfig,
  ClusterResolutionResult,
  ScoredCandidate,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { clusterAcrossSegments, clusterToCandidate } from './clustering';
import { scoreCandidates, type GraphContext } from './scoring';
import { resolveCluster, needsLLMRefinement, summarizeDecision } from './thresholding';
import { ensurePhoneticReady } from './aliasPatterns';
import {
  buildBlockingIndex,
  filterByBlocking,
  getBlockingStats,
} from './blocking';
import { logger } from '../../utils/logger';

export interface ResolverOptions {
  documentId: string;
  userId: string;
  config?: Partial<ResolutionConfig>;
}

export interface ResolveResult {
  results: ClusterResolutionResult[];
  stats: {
    totalClusters: number;
    autoMerged: number;
    needsReview: number;
    created: number;
    llmRefinementNeeded: number;
  };
}

/**
 * Resolve entities against existing graph entities.
 *
 * Flow:
 * 1. Cluster extracted entities (within and across segments)
 * 2. For each cluster, score against existing entities
 * 3. Apply thresholds to make MERGE/REVIEW/CREATE decisions
 */
export async function resolveEntities(
  extractedEntities: EntityCandidate[],
  existingEntities: ExistingEntity[],
  options: ResolverOptions,
  getGraphContext?: (entityId: string) => GraphContext | undefined
): Promise<ResolveResult> {
  const config: ResolutionConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
  };

  logger.info(
    {
      documentId: options.documentId,
      extractedCount: extractedEntities.length,
      existingCount: existingEntities.length,
    },
    'Entity resolution: Starting batch clustering'
  );

  // Load phonetic matching library (async ESM import)
  await ensurePhoneticReady();

  // Step 1: Cluster extracted entities
  const clusters = clusterAcrossSegments(extractedEntities, config.thresholds);

  logger.info(
    {
      documentId: options.documentId,
      clusterCount: clusters.length,
      originalCount: extractedEntities.length,
    },
    'Entity resolution: Clustering complete'
  );

  // Step 2: Build blocking index for efficient candidate filtering
  const blockingIndex = buildBlockingIndex(existingEntities);
  const blockingStats = getBlockingStats(blockingIndex);

  logger.debug(
    {
      documentId: options.documentId,
      ...blockingStats,
    },
    'Entity resolution: Blocking index built'
  );

  // Step 3: Score each cluster against blocked candidates
  const results: ClusterResolutionResult[] = [];
  const stats = {
    totalClusters: clusters.length,
    autoMerged: 0,
    needsReview: 0,
    created: 0,
    llmRefinementNeeded: 0,
  };

  for (const cluster of clusters) {
    // Convert cluster to candidate for scoring
    const candidate = clusterToCandidate(cluster);

    // Use blocking to filter candidates (O(k) instead of O(n))
    const blockedCandidates = filterByBlocking(
      cluster,
      existingEntities,
      blockingIndex
    );

    // Score only blocked candidates
    const scoredCandidates = scoreCandidates(
      candidate,
      blockedCandidates,
      getGraphContext
    );

    // Apply thresholds
    const result = resolveCluster(cluster, scoredCandidates, config.thresholds);

    // Track stats
    switch (result.decision) {
      case 'MERGE':
        stats.autoMerged++;
        break;
      case 'REVIEW':
        stats.needsReview++;
        if (needsLLMRefinement(result, config.llmScoreRange)) {
          stats.llmRefinementNeeded++;
        }
        break;
      case 'CREATE':
        stats.created++;
        break;
    }

    logger.debug(
      {
        clusterName: cluster.primaryName,
        decision: summarizeDecision(result),
      },
      'Entity resolution: Cluster resolved'
    );

    results.push(result);
  }

  logger.info(
    {
      documentId: options.documentId,
      ...stats,
    },
    'Entity resolution: Complete'
  );

  return { results, stats };
}

/**
 * Get scored candidates for a single cluster.
 * Useful for UI display of resolution options.
 */
export function getResolutionCandidates(
  cluster: EntityCluster,
  existingEntities: ExistingEntity[],
  getGraphContext?: (entityId: string) => GraphContext | undefined
): ScoredCandidate[] {
  const candidate = clusterToCandidate(cluster);

  const typeFilteredExisting = existingEntities.filter(
    (e) => e.type === candidate.type
  );

  return scoreCandidates(candidate, typeFilteredExisting, getGraphContext);
}

/**
 * Map old resolution decisions to new format.
 * For backwards compatibility with existing code.
 */
export function mapToLegacyDecision(
  result: ClusterResolutionResult
): 'MERGE' | 'UPDATE' | 'ADD_FACET' | 'NEW' {
  switch (result.decision) {
    case 'MERGE':
      // If there are new facets, use ADD_FACET
      if (result.newFacets && result.newFacets.length > 0) {
        return 'ADD_FACET';
      }
      return 'MERGE';
    case 'REVIEW':
      // For review, we create provisional (treated as new for now)
      return 'NEW';
    case 'CREATE':
      return 'NEW';
  }
}

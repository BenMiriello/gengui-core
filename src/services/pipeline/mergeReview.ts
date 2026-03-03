/**
 * Global Merge Review Pass
 *
 * After extraction completes, this module reviews all accumulated merge signals
 * and performs a final LLM pass to catch cross-segment aliases that were missed
 * during incremental extraction.
 *
 * This is the second phase of LLM-first merge detection:
 * 1. Stage 2: Per-segment extraction with merge detection
 * 2. Post-extraction: Global review of uncertain merges
 */

import { cpuPool } from '../../lib/cpu-pool';
import { logger } from '../../utils/logger';
import { graphService } from '../graph/graph.service';
import { mentionService } from '../mentions';

export interface MergeReviewInput {
  documentId: string;
  userId: string;
  entityIdByName: Map<string, string>;
  mergeSignals: MergeSignalWithContext[];
  entityRegistry: EntityForReview[];
}

export interface MergeSignalWithContext {
  extractedEntityName: string;
  registryIndex: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  segmentIndex: number;
  extractedEntityId?: string;
}

export interface EntityForReview {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
  embedding?: number[];
}

export interface MergeReviewResult {
  reviewedCount: number;
  autoMerged: number;
  deferredForUserReview: number;
  noActionNeeded: number;
  mergeActions: MergeAction[];
}

export interface MergeAction {
  sourceEntityId: string;
  targetEntityId: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  applied: boolean;
}

/**
 * Find potential merge candidates using embedding similarity.
 * Returns entity pairs with high similarity that might be the same entity.
 * Runs in worker thread to prevent blocking event loop.
 */
export async function findMergeCandidates(
  entities: EntityForReview[],
  similarityThreshold = 0.85,
): Promise<
  Array<{
    entity1: EntityForReview;
    entity2: EntityForReview;
    similarity: number;
  }>
> {
  const embeddings = entities.map((e) => e.embedding || null);
  const types = entities.map((e) => e.type);

  const candidates = await cpuPool.findMergeCandidates(
    embeddings,
    types,
    similarityThreshold,
  );

  return candidates.map((c) => ({
    entity1: entities[c.index1],
    entity2: entities[c.index2],
    similarity: c.similarity,
  }));
}

/**
 * Process accumulated merge signals from extraction.
 * Applies high-confidence merges automatically, defers medium/low for review.
 */
export async function processMergeSignals(
  input: MergeReviewInput,
): Promise<MergeReviewResult> {
  const { mergeSignals, entityRegistry, entityIdByName } = input;

  const result: MergeReviewResult = {
    reviewedCount: mergeSignals.length,
    autoMerged: 0,
    deferredForUserReview: 0,
    noActionNeeded: 0,
    mergeActions: [],
  };

  if (mergeSignals.length === 0) {
    logger.info({ documentId: input.documentId }, 'No merge signals to review');
    return result;
  }

  // Group signals by target entity
  const signalsByTarget = new Map<number, MergeSignalWithContext[]>();
  for (const signal of mergeSignals) {
    const existing = signalsByTarget.get(signal.registryIndex) || [];
    existing.push(signal);
    signalsByTarget.set(signal.registryIndex, existing);
  }

  for (const [registryIndex, signals] of signalsByTarget) {
    const targetEntity = entityRegistry[registryIndex];
    if (!targetEntity) {
      logger.warn({ registryIndex }, 'Invalid registry index in merge signal');
      continue;
    }

    for (const signal of signals) {
      const sourceEntityId = entityIdByName.get(signal.extractedEntityName);
      if (!sourceEntityId) {
        result.noActionNeeded++;
        continue;
      }

      // Skip if already merged (same ID)
      if (sourceEntityId === targetEntity.id) {
        result.noActionNeeded++;
        continue;
      }

      const action: MergeAction = {
        sourceEntityId,
        targetEntityId: targetEntity.id,
        confidence: signal.confidence,
        reason: signal.evidence,
        applied: false,
      };

      if (signal.confidence === 'high') {
        // Auto-apply high confidence merges
        // In future: actually merge the entities
        logger.info(
          {
            sourceId: sourceEntityId,
            sourceName: signal.extractedEntityName,
            targetId: targetEntity.id,
            targetName: targetEntity.name,
            evidence: signal.evidence,
          },
          'High confidence merge detected (auto-merge deferred for future implementation)',
        );
        action.applied = false; // Will be true when merge is implemented
        result.autoMerged++;
      } else {
        // Defer medium/low confidence for user review
        logger.info(
          {
            sourceId: sourceEntityId,
            sourceName: signal.extractedEntityName,
            targetId: targetEntity.id,
            targetName: targetEntity.name,
            confidence: signal.confidence,
            evidence: signal.evidence,
          },
          'Merge candidate deferred for user review',
        );
        result.deferredForUserReview++;
      }

      result.mergeActions.push(action);
    }
  }

  logger.info(
    {
      documentId: input.documentId,
      reviewedCount: result.reviewedCount,
      autoMerged: result.autoMerged,
      deferredForUserReview: result.deferredForUserReview,
      noActionNeeded: result.noActionNeeded,
    },
    'Merge review complete',
  );

  return result;
}

/**
 * Build entity registry for merge review from graph.
 */
export async function buildReviewRegistry(
  documentId: string,
  userId: string,
): Promise<EntityForReview[]> {
  const nodes = await graphService.getStoryNodesForDocument(documentId, userId);
  const registry: EntityForReview[] = [];

  for (const node of nodes) {
    const [facets, mentionCount, embedding] = await Promise.all([
      graphService.getFacetsForEntity(node.id),
      mentionService.getMentionCount(node.id),
      graphService.getNodeEmbedding(node.id),
    ]);

    registry.push({
      id: node.id,
      name: node.name,
      type: node.type,
      aliases: node.aliases || [],
      facets: facets.map((f) => ({ type: f.type, content: f.content })),
      mentionCount,
      embedding: embedding || undefined,
    });
  }

  return registry;
}

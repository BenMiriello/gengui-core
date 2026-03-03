/**
 * Multi-stage extraction pipeline.
 *
 * Stage 1: Segmentation + Sentence Embeddings (algorithmic)
 * Stage 2: Segment Summarization (LLM, parallel)
 * Stage 3: Entity + Facet Extraction (LLM, multi-segment batching)
 * Stage 4: Entity Resolution (multi-signal batch clustering)
 * Stage 5: Intra-Segment Relationships (LLM, parallel per segment)
 * Stage 6: Cross-Segment Relationships (LLM, sequential)
 * Stage 7: Higher-Order Analysis (LLM + algorithmic)
 * Stage 8: CharacterState Facet Attachment (algorithmic)
 * Stage 9: Conflict Detection (algorithmic)
 *
 * Note: Stage 4 (Text Grounding) was removed as it was a no-op placeholder.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { getTextModelConfig } from '../../config/text-models';
import { documents, reviewQueue } from '../../models/schema';
import type {
  ArcType,
  FacetInput,
  FacetType,
  StoryEdgeType,
  StoryNodeType,
} from '../../types/storyNodes';
import { generateRequestId, logger } from '../../utils/logger';
import { logStageComplete, logStageStart } from '../../utils/logHelpers';
import {
  calculateAllBatches,
  countTokens,
  extractionConfig,
  type SegmentWithText,
} from '../contextBudget';
// TODO: Re-enable when review queue UI is built and conflict detection is fixed
// import { reviewQueueService } from '../reviewQueue';
import {
  changeLogService,
  createTrackedArc,
  createTrackedEdge,
  createTrackedEntity,
  createTrackedFacet,
  createTrackedState,
  createTrackedStateTransition,
  createTrackedThread,
} from '../changelog';
import { descriptionService } from '../descriptionGeneration';
import { generateEmbedding, generateEmbeddings } from '../embeddings';
import {
  analyzeHigherOrder,
  detectContradictionsInBatch,
  type EntityRegistryEntry,
  type ExistingMatch,
  extractCrossSegmentRelationships,
  extractEntitiesFromBatch,
  type MergeSignal,
  type SegmentInput,
  type Stage4RelationshipsResult,
  type Stage5HigherOrderResult,
} from '../gemini/client';
import { getGeminiClient } from '../gemini/core';
import { recomputeAndUpdatePrimaryName } from '../graph/entityNames.js';
import { computeCausalOrder } from '../graph/graph.analysis';
import { graphService } from '../graph/graph.service';
import type { StoredFacet, StoredStoryNode } from '../graph/graph.types';
import { mentionService } from '../mentions';
import type { Segment } from '../segments';
import { segmentService } from '../segments';
import { processBatchesInParallel } from './batchProcessing';
import { sentenceService } from '../sentences';
import { sseService } from '../sse';
import {
  graphStoryNodesRepository,
  recomputeEntityEmbeddingWithMentionWeights,
} from '../storyNodes';
import {
  generateDocumentSummary,
  generateSegmentSummaryWithRetry,
  CONFIG as SUMMARY_CONFIG,
  selectSummariesForContext,
} from '../summarization';
import {
  clearCheckpoint,
  isCheckpointValid,
  loadCheckpoint,
  saveCheckpoint,
  shouldRunStage,
} from './checkpoint';
import { AnalysisCancelledError, AnalysisPausedError } from './errors';
import {
  type AnalysisStage,
  getStageInfo,
  getStageLabel,
  TOTAL_STAGES,
} from './stages';

/**
 * Check if the analysis has been paused or cancelled.
 * Throws an appropriate error if so.
 */
async function checkForInterruption(documentId: string): Promise<void> {
  const [doc] = await db
    .select({ analysisStatus: documents.analysisStatus })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (doc?.analysisStatus === 'cancelled') {
    throw new AnalysisCancelledError('Analysis cancelled by user');
  }

  if (doc?.analysisStatus === 'paused') {
    throw new AnalysisPausedError('Analysis paused by user');
  }
}

export interface PipelineOptions {
  documentId: string;
  userId: string;
  documentContent: string;
  segments: Segment[];
  versionNumber: number;
  documentStyle?: { preset: string | null; prompt: string | null };
  documentTitle?: string;
  isInitialExtraction: boolean;
  broadcastProgress?: boolean;
}

export interface PipelineResult {
  entityCount: number;
  relationshipCount: number;
  threadCount: number;
  arcCount: number;
}

interface ExtractedEntity {
  segmentId: string;
  name: string;
  type: StoryNodeType;
  documentOrder?: number;
  facets: FacetInput[];
  mentions: Array<{ text: string }>;
  existingMatch?: ExistingMatch;
}

/** Accumulated merge signal for post-extraction review */
interface AccumulatedMergeSignal extends MergeSignal {
  segmentIndex: number;
  extractedEntityId?: string;
}

interface ResolvedEntity extends ExtractedEntity {
  id: string;
  decision: 'MERGE' | 'UPDATE' | 'ADD_FACET' | 'NEW';
  targetEntityId?: string;
}

interface EntityWithSegments {
  id: string;
  name: string;
  type: string;
  segmentIds: string[];
  keyFacets: string[];
  aliases?: string[];
}

/** Runtime entity registry used during extraction */
interface RuntimeEntityRegistry {
  entries: Map<string, RuntimeEntityEntry>;
  nextIndex: number;
}

interface RuntimeEntityEntry {
  registryIndex: number;
  id: string;
  name: string;
  type: string;
  aliases: string[];
  facets: FacetInput[];
  mentionCount: number;
  embedding?: number[];
  /** Segment indices where this entity appears (for event chain context) */
  segmentIndices: Set<number>;
}

/**
 * Get representative embedding for a segment by averaging its sentence embeddings.
 * Uses existing sentence embeddings from Stage 1 (no new API calls).
 * Returns null if no embeddings exist (will fall back to mention count sorting).
 */
async function getSegmentRepresentativeEmbedding(
  documentId: string,
  segmentId: string,
): Promise<number[] | null> {
  try {
    // Load stored sentence embeddings for this segment
    const sentences = await sentenceService.getBySegmentIds(documentId, [
      segmentId,
    ]);

    if (sentences.length === 0 || !sentences[0].embedding) {
      return null;
    }

    // Average all sentence embeddings to get segment representative
    const embeddings = sentences
      .map((s) => s.embedding)
      .filter((e): e is number[] => !!e);

    if (embeddings.length === 0) {
      return null;
    }

    // Compute average embedding (centroid)
    const dim = embeddings[0].length;
    const avgEmbedding = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        avgEmbedding[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      avgEmbedding[i] /= embeddings.length;
    }

    return avgEmbedding;
  } catch (error) {
    logger.warn(
      { documentId, segmentId, error },
      'Failed to load segment embedding, falling back to mention count',
    );
    return null;
  }
}

/**
 * Build entity registry for prompt inclusion.
 * Sorted by semantic relevance to the current segment (embedding similarity).
 * Falls back to mention count if no segment embedding provided.
 */
function buildEntityRegistryForPrompt(
  registry: RuntimeEntityRegistry,
  segmentEmbedding?: number[] | null,
  maxEntries = 50,
): EntityRegistryEntry[] {
  let entries = Array.from(registry.entries.values());

  if (segmentEmbedding && entries.some((e) => e.embedding)) {
    // Sort by semantic similarity to current segment
    entries = entries
      .map((e) => ({
        entry: e,
        similarity: e.embedding
          ? cosineSimilarity(e.embedding, segmentEmbedding)
          : 0,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxEntries)
      .map((r) => r.entry);
  } else {
    // Fallback: sort by mention count
    entries = entries
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, maxEntries);
  }

  return entries.map((e) => {
    const nameFacets = e.facets
      .filter((f) => f.type === 'name')
      .map((f) => f.content);
    const traitFacets = e.facets
      .filter((f) => f.type === 'trait' || f.type === 'appearance')
      .slice(0, 3)
      .map((f) => f.content);

    return {
      registryIndex: e.registryIndex,
      id: e.id,
      name: e.name,
      type: e.type,
      aliases:
        [...e.aliases, ...nameFacets].length > 0
          ? [...new Set([...e.aliases, ...nameFacets])]
          : undefined,
      summary: traitFacets.length > 0 ? traitFacets.join('; ') : undefined,
      segmentIndices: e.segmentIndices.size > 0
        ? Array.from(e.segmentIndices).sort((a, b) => a - b)
        : undefined,
    };
  });
}

/**
 * Add or update entity in the runtime registry.
 */
function updateEntityRegistry(
  registry: RuntimeEntityRegistry,
  entity: ExtractedEntity,
  entityId: string,
  segmentIndex?: number,
): void {
  const existing = registry.entries.get(entityId);

  if (existing) {
    existing.mentionCount += entity.mentions.length;
    if (segmentIndex !== undefined) {
      existing.segmentIndices.add(segmentIndex);
    }
    for (const facet of entity.facets) {
      const key = `${facet.type}:${facet.content}`;
      if (!existing.facets.some((f) => `${f.type}:${f.content}` === key)) {
        existing.facets.push(facet);
      }
    }
    if (
      entity.name !== existing.name &&
      !existing.aliases.includes(entity.name)
    ) {
      existing.aliases.push(entity.name);
    }
  } else {
    // Extract name facets as aliases for immediate availability in registry
    const nameFacetAliases = entity.facets
      .filter((f) => f.type === 'name')
      .map((f) => f.content);

    registry.entries.set(entityId, {
      registryIndex: registry.nextIndex++,
      id: entityId,
      name: entity.name,
      type: entity.type,
      aliases: nameFacetAliases,
      facets: [...entity.facets],
      mentionCount: entity.mentions.length,
      segmentIndices: new Set(segmentIndex !== undefined ? [segmentIndex] : []),
    });
  }
}

/**
 * Register all name variants for an entity in the alias map.
 * This enables Stage 5 relationship extraction to resolve name variants.
 */
function registerEntityAliases(
  aliasMap: Map<string, string>,
  entityId: string,
  entity: ExtractedEntity,
): void {
  const register = (name: string) => {
    const normalized = name.toLowerCase().trim();
    if (normalized) {
      aliasMap.set(normalized, entityId);
    }
  };

  // Primary name
  register(entity.name);

  // Name facets
  for (const facet of entity.facets) {
    if (facet.type === 'name') {
      register(facet.content);
    }
  }

  // Normalized variants (without articles)
  const withoutArticle = entity.name.replace(/^(the|a|an)\s+/i, '').trim();
  if (withoutArticle !== entity.name) {
    register(withoutArticle);
  }
}

export const multiStagePipeline = {
  /**
   * Run the full multi-stage extraction pipeline.
   */
  async run(options: PipelineOptions): Promise<PipelineResult> {
    const {
      documentId,
      userId,
      documentContent,
      segments,
      versionNumber,
      documentStyle,
      documentTitle,
      isInitialExtraction,
      broadcastProgress = true,
    } = options;

    // Generate correlation ID for this analysis run
    const requestId = generateRequestId();
    const childLogger = logger.child({
      requestId,
      documentId,
      userId,
      versionNumber,
    });

    childLogger.info(
      {
        segmentCount: segments.length,
        contentLength: documentContent.length,
        isInitialExtraction,
      },
      'Analysis pipeline started',
    );

    const pipelineStartTime = Date.now();

    const broadcast = (
      stage: AnalysisStage,
      entityCount?: number,
      statusHint?: string,
    ) => {
      if (!broadcastProgress) return;
      const stageInfo = getStageInfo(stage);
      sseService.broadcastToDocument(documentId, 'analysis-progress', {
        documentId,
        stage,
        totalStages: TOTAL_STAGES,
        stageName: stageInfo?.name || `Stage ${stage}`,
        stageDescription: stageInfo?.description,
        statusHint:
          statusHint || stageInfo?.genericLabel || getStageLabel(stage),
        entityCount,
        timestamp: new Date().toISOString(),
      });
    };

    let checkpoint = await loadCheckpoint(documentId);

    if (checkpoint && !isCheckpointValid(checkpoint, versionNumber)) {
      childLogger.info(
        {
          checkpointVersion: checkpoint.documentVersion,
          currentVersion: versionNumber,
        },
        'Document version changed, invalidating checkpoint',
      );
      await clearCheckpoint(documentId);
      checkpoint = null;
    }

    // Defensive: Validate checkpoint matches document state
    if (checkpoint) {
      const [doc] = await db
        .select({
          analysisStatus: documents.analysisStatus,
          analysisCheckpoint: documents.analysisCheckpoint,
        })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      // If status is not analyzing/paused, checkpoint is stale
      if (
        doc?.analysisStatus !== 'analyzing' &&
        doc?.analysisStatus !== 'paused'
      ) {
        childLogger.warn(
          {
            status: doc?.analysisStatus,
            checkpointStage: checkpoint.lastStageCompleted,
          },
          'Found stale checkpoint for non-analyzing document - clearing',
        );
        await clearCheckpoint(documentId);
        checkpoint = null;
      }

      // If checkpoint shows previous failure, clear for fresh start
      if (checkpoint?.failedAtStage) {
        childLogger.warn(
          {
            failedAtStage: checkpoint.failedAtStage,
            reason: checkpoint.failureReason,
          },
          'Checkpoint shows previous failure - clearing for fresh start',
        );
        await clearCheckpoint(documentId);
        checkpoint = null;
      }
    }

    if (checkpoint) {
      childLogger.info(
        { lastStageCompleted: checkpoint.lastStageCompleted },
        'Resuming from checkpoint',
      );
    }

    // Stage 1: Segmentation + Sentence Embeddings
    if (shouldRunStage(checkpoint, 1)) {
      const stage1StartTime = Date.now();
      await checkForInterruption(documentId);
      broadcast(1);
      logStageStart(childLogger, 1, 'Segmentation + Sentence Embeddings', {
        segmentCount: segments.length,
      });

      await sentenceService.processDocument(
        documentId,
        documentContent,
        segments,
      );

      await saveCheckpoint(documentId, {
        documentVersion: versionNumber,
        lastStageCompleted: 1,
      });

      const stage1DurationMs = Date.now() - stage1StartTime;
      const allSentences = await sentenceService.getByDocumentId(documentId);
      const totalSentences = allSentences.length;
      logStageComplete(
        childLogger,
        1,
        'Segmentation + Sentence Embeddings',
        stage1DurationMs,
        {
          segmentCount: segments.length,
          sentenceCount: totalSentences,
          avgSentencesPerSegment:
            segments.length > 0
              ? (totalSentences / segments.length).toFixed(1)
              : 0,
        },
      );
    } else {
      childLogger.info('Skipping Stage 1 (already completed)');
    }

    // Stage 2: Segment Summarization
    if (shouldRunStage(checkpoint, 2)) {
      await checkForInterruption(documentId);
      broadcast(2);
      logStageStart(childLogger, 2, 'Segment Summarization', {
        segmentCount: segments.length,
      });

      const startTime = Date.now();

      const [existingDoc] = await db
        .select({ segmentSequence: documents.segmentSequence })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      const existingSegments =
        (existingDoc?.segmentSequence as Segment[]) || [];

      const needsRegeneration = segments.map((seg, i) => {
        const existing = existingSegments[i];
        return (
          !existing?.summary ||
          existing.summaryVersion !== versionNumber ||
          existing.hash !== seg.hash
        );
      });

      const { default: pMap } = await import('p-map');

      const segmentSummaries = await pMap(
        segments,
        async (segment, index) => {
          if (!needsRegeneration[index] && existingSegments[index]?.summary) {
            logger.debug(
              {
                segmentIndex: index,
                version: existingSegments[index].summaryVersion,
              },
              'Reusing existing summary',
            );
            return {
              segmentId: segment.id,
              summary: existingSegments[index].summary!,
            };
          }

          const segmentText = documentContent.slice(segment.start, segment.end);
          const summary = await generateSegmentSummaryWithRetry(
            segmentText,
            index,
            segments.length,
            userId,
            documentId,
          );
          return { segmentId: segment.id, summary };
        },
        { concurrency: SUMMARY_CONFIG.summaryConcurrency, stopOnError: false },
      );

      const successfulSummaries = segmentSummaries.filter(
        (s) => s.summary && !s.summary.endsWith('...'),
      );

      const segmentsWithSummaries = segments.map((seg) => {
        const summaryData = segmentSummaries.find(
          (s) => s.segmentId === seg.id,
        );
        return {
          ...seg,
          summary: summaryData?.summary,
          summaryVersion: versionNumber,
          summaryUpdatedAt: new Date().toISOString(),
        };
      });

      await db
        .update(documents)
        .set({
          segmentSequence: segmentsWithSummaries,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      let documentSummaryText: string;
      try {
        documentSummaryText = await generateDocumentSummary(
          segmentSummaries.map((s) => s.summary),
          userId,
          documentId,
          documentTitle,
        );
      } catch (error) {
        logger.error(
          { documentId, error },
          'Document summary generation failed, using concatenation fallback',
        );
        documentSummaryText = segmentSummaries
          .map((s, i) => `[Segment ${i + 1}]: ${s.summary}`)
          .join('\n\n')
          .slice(0, 2000);
      }

      await db
        .update(documents)
        .set({
          summary: documentSummaryText,
          summaryEditChainLength: 0,
          summaryUpdatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      const durationMs = Date.now() - startTime;

      logStageComplete(childLogger, 2, 'Segment Summarization', durationMs, {
        totalSegments: segments.length,
        successfulSummaries: successfulSummaries.length,
        failedSummaries: segments.length - successfulSummaries.length,
        regenerated: needsRegeneration.filter(Boolean).length,
        reused: needsRegeneration.filter((n) => !n).length,
        avgMsPerSummary: Math.round(durationMs / segments.length),
      });

      await saveCheckpoint(documentId, {
        lastStageCompleted: 2,
        summaryData: { segmentSummaries, documentSummary: documentSummaryText },
      });
    } else {
      childLogger.info('Skipping Stage 2 (already completed)');
    }

    // Stage 3: Entity + Facet Extraction with LLM-First Merge Detection
    let extractedEntities: ExtractedEntity[];
    let entityIdByName: Map<string, string>;
    let aliasToEntityId: Map<string, string>;
    let accumulatedMergeSignals: AccumulatedMergeSignal[];

    if (shouldRunStage(checkpoint, 3)) {
      const stage3StartTime = Date.now();
      await checkForInterruption(documentId);
      broadcast(3);
      logStageStart(childLogger, 3, 'Entity Extraction');

      const progress = checkpoint?.stage3Progress;
      const completedSegments = new Set<number>(
        progress?.completedSegmentIndices || [],
      );
      extractedEntities = progress?.extractedEntities || [];
      entityIdByName = new Map<string, string>(
        Object.entries(progress?.entityIdByName || {}),
      );
      aliasToEntityId = new Map<string, string>(
        Object.entries(progress?.aliasToEntityId || {}),
      );
      accumulatedMergeSignals = progress?.mergeSignals || [];
      let totalBatchesProcessed = 0;

      if (completedSegments.size > 0) {
        logger.info(
          {
            documentId,
            completedSegments: completedSegments.size,
            totalSegments: segments.length,
          },
          'Resuming Stage 3 from checkpoint progress',
        );
      }

      // Runtime registry tracks entities as they're extracted
      const runtimeRegistry: RuntimeEntityRegistry = {
        entries: new Map(),
        nextIndex: 0,
      };

      // Rebuild registry from already-extracted entities
      for (const entity of extractedEntities) {
        const entityId = entityIdByName.get(entity.name);
        if (entityId) {
          // Find segment index for this entity
          const segmentIndex = segments.findIndex((s) => s.id === entity.segmentId);
          updateEntityRegistry(
            runtimeRegistry,
            entity,
            entityId,
            segmentIndex !== -1 ? segmentIndex : undefined,
          );
        }
      }

      // Load existing entities into registry if incremental
      if (!isInitialExtraction) {
        const existingNodes = await graphStoryNodesRepository.getActiveNodes(
          documentId,
          userId,
        );
        for (const node of existingNodes) {
          if (runtimeRegistry.entries.has(node.id)) continue;

          const [facets, mentionCount, embedding] = await Promise.all([
            graphService.getFacetsForEntity(node.id),
            mentionService.getMentionCount(node.id),
            graphService.getNodeEmbedding(node.id),
          ]);

          runtimeRegistry.entries.set(node.id, {
            registryIndex: runtimeRegistry.nextIndex++,
            id: node.id,
            name: node.name,
            type: node.type,
            aliases: node.aliases || [],
            facets: facets.map((f) => ({
              type: f.type as FacetType,
              content: f.content,
            })),
            mentionCount,
            embedding: embedding || undefined,
            segmentIndices: new Set(), // Will be populated from mentions if needed
          });
          entityIdByName.set(node.name, node.id);
        }
      }

      const [docWithSummaries] = await db
        .select({
          segmentSequence: documents.segmentSequence,
          summary: documents.summary,
        })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      const segmentsWithSummaries =
        (docWithSummaries?.segmentSequence as Segment[]) || segments;
      const documentSummary = docWithSummaries?.summary;

      const segmentsWithText: SegmentWithText[] = segmentsWithSummaries.map(
        (seg, idx) => ({
          ...seg,
          index: idx,
          text: documentContent.slice(seg.start, seg.end),
        }),
      );

      // Find first uncompleted segment for resumption
      const firstUncompletedIndex = segmentsWithText.findIndex(
        (s) => !completedSegments.has(s.index),
      );

      if (firstUncompletedIndex === -1) {
        logger.info({ documentId }, 'All segments already processed');
      } else {
        // Get remaining segments to process
        const remainingSegments = segmentsWithText.slice(firstUncompletedIndex);

        // Calculate batches using budget calculator
        const modelConfig = getTextModelConfig('gemini-2.5-flash');
        const batches = calculateAllBatches({
          modelConfig,
          operationConfig: extractionConfig,
          items: remainingSegments,
          overlapSize: 1,
          getOverlapContext: (seg) => seg.text,
        });

        totalBatchesProcessed = batches.length;
        logger.info(
          {
            documentId,
            totalSegments: segments.length,
            remainingSegments: remainingSegments.length,
            batchCount: batches.length,
            batchSizes: batches.map((b) => b.includedCount),
          },
          'Calculated segment batches for extraction',
        );

        // Process each batch
        let completedBatchCount = 0;
        try {
          for (const batch of batches) {
            const batchSegments = batch.includedItems;
            const segmentIndices = batchSegments.map((s) => s.index);

            // Skip batch if all segments already completed
            if (batchSegments.every((s) => completedSegments.has(s.index))) {
              logger.debug({ segmentIndices }, 'Skipping completed batch');
              continue;
            }

            // Get representative embedding for first segment (for semantic registry sorting)
            // Uses existing sentence embeddings from Stage 1, no new API calls
            const firstSegmentEmbedding =
              await getSegmentRepresentativeEmbedding(
                documentId,
                batchSegments[0].id,
              );

            // Calculate dynamic entity registry limit based on remaining context budget
            // Batch includes segments + system prompt + output reserve
            const segmentTokens = batch.tokenBreakdown.items;
            const systemTokens = batch.tokenBreakdown.systemPrompt;
            const outputReserve = batch.tokenBreakdown.outputReserve;
            const usedTokens = segmentTokens + systemTokens + outputReserve;
            const availableTokens = batch.tokenBreakdown.available;
            const remainingBudget = Math.max(0, availableTokens - usedTokens);

            // Estimate tokens per entity: name + type + aliases + summary ≈ 100 tokens
            const avgTokensPerEntity = 100;
            const maxEntityEntries = Math.max(
              10, // Minimum 10 entities
              Math.floor(remainingBudget / avgTokensPerEntity),
            );

            // Build entity registry for this batch (sorted by semantic relevance if embedding available)
            const entityRegistry = buildEntityRegistryForPrompt(
              runtimeRegistry,
              firstSegmentEmbedding,
              maxEntityEntries,
            );

            // Log batch info
            logger.debug(
              {
                batchSegmentCount: batchSegments.length,
                segmentIndices,
                registrySize: entityRegistry.length,
                registryLimit: maxEntityEntries,
                remainingBudget,
                semanticSorting: !!firstSegmentEmbedding,
              },
              'Processing segment batch with dynamic entity limit',
            );

            broadcast(
              3,
              runtimeRegistry.entries.size,
              `Processing segments ${segmentIndices[0] + 1}-${segmentIndices[segmentIndices.length - 1] + 1} of ${segments.length}...`,
            );

            // Get overlap text from previous segment if available
            // Include overlap regardless of completion status - overlap provides context
            let overlapText: string | undefined;
            const firstBatchIndex = batchSegments[0].index;
            if (firstBatchIndex > 0) {
              const prevSeg = segmentsWithText[firstBatchIndex - 1];
              overlapText = prevSeg?.text;
            }

            const segmentInputs: SegmentInput[] = batchSegments.map((seg) => ({
              id: seg.id,
              index: seg.index,
              text: seg.text,
            }));

            const modelConfig = getTextModelConfig('gemini-2.5-flash');
            const summaryBudgetTokens = Math.floor(
              modelConfig.maxTokens *
                (modelConfig.targetUtilization ?? 0.8) *
                SUMMARY_CONFIG.summaryBudgetPct,
            );

            const batchIndices = batchSegments.map((s) => s.index);
            const selectedSummaries = selectSummariesForContext({
              currentBatchIndices: batchIndices,
              allSegments: segmentsWithSummaries,
              availableTokens: summaryBudgetTokens,
            });

            const segmentSummariesForPrompt = selectedSummaries
              .filter((seg) => seg.summary)
              .map((seg) => ({
                index: segmentsWithSummaries.findIndex((s) => s.id === seg.id),
                summary: seg.summary!,
              }));

            const result = await extractEntitiesFromBatch(
              segmentInputs,
              segments.length,
              userId,
              documentId,
              entityRegistry,
              overlapText,
              segmentSummariesForPrompt,
              documentSummary ?? undefined,
            );

            // Check if cancelled/paused after LLM call
            await checkForInterruption(documentId);

            // Create segment lookup map
            const segmentById = new Map(batchSegments.map((s) => [s.id, s]));

            // Process extracted entities
            for (const entity of result.entities) {
              const segment = segmentById.get(entity.segmentId);
              if (!segment) {
                logger.warn(
                  { entityName: entity.name, segmentId: entity.segmentId },
                  'Entity references unknown segment, skipping',
                );
                continue;
              }

              const entityFacets = result.facets
                .filter(
                  (f) =>
                    f.entityName === entity.name &&
                    f.segmentId === entity.segmentId,
                )
                .map((f) => ({
                  type: f.facetType as FacetType,
                  content: f.content,
                }));

              const entityMentions = result.mentions
                .filter(
                  (m) =>
                    m.entityName === entity.name &&
                    m.segmentId === entity.segmentId,
                )
                .map((m) => ({ text: m.text }));

              // Determine entity ID based on LLM's existingMatch (name-based lookup)
              let entityId: string;
              if (
                entity.existingMatch &&
                entity.existingMatch.confidence !== 'low'
              ) {
                // First try: lookup by primary name in full registry
                let matchedEntry = Array.from(
                  runtimeRegistry.entries.values(),
                ).find(
                  (e) =>
                    e.name.toLowerCase() ===
                      entity.existingMatch!.matchedName.toLowerCase() &&
                    e.type.toLowerCase() ===
                      entity.existingMatch!.matchedType.toLowerCase(),
                );

                // Second try: lookup by alias
                if (!matchedEntry) {
                  const matchedNameLower =
                    entity.existingMatch.matchedName.toLowerCase();
                  const aliasEntityId = aliasToEntityId.get(matchedNameLower);
                  if (aliasEntityId) {
                    matchedEntry = runtimeRegistry.entries.get(aliasEntityId);
                    // Verify type matches
                    if (
                      matchedEntry &&
                      matchedEntry.type.toLowerCase() !==
                        entity.existingMatch.matchedType.toLowerCase()
                    ) {
                      matchedEntry = undefined;
                    }
                  }
                }

                if (matchedEntry) {
                  entityId = matchedEntry.id;
                  logger.info(
                    {
                      entityName: entity.name,
                      matchedName: matchedEntry.name,
                      matchedType: matchedEntry.type,
                      confidence: entity.existingMatch.confidence,
                      reason: entity.existingMatch.reason,
                    },
                    'LLM matched entity to existing',
                  );
                } else {
                  entityId = randomUUID();
                  logger.warn(
                    {
                      entityName: entity.name,
                      matchedName: entity.existingMatch.matchedName,
                      matchedType: entity.existingMatch.matchedType,
                    },
                    'LLM matched to non-existent registry entry, creating new entity',
                  );
                }
              } else {
                entityId = randomUUID();
              }

              const extracted: ExtractedEntity = {
                segmentId: segment.id,
                name: entity.name,
                type: entity.type as StoryNodeType,
                documentOrder: entity.documentOrder,
                facets: entityFacets,
                mentions: entityMentions,
                existingMatch: entity.existingMatch,
              };

              extractedEntities.push(extracted);
              entityIdByName.set(entity.name, entityId);
              registerEntityAliases(aliasToEntityId, entityId, extracted);
              updateEntityRegistry(runtimeRegistry, extracted, entityId, segment.index);
            }

            // Accumulate merge signals
            if (result.mergeSignals && result.mergeSignals.length > 0) {
              for (const signal of result.mergeSignals) {
                accumulatedMergeSignals.push({
                  ...signal,
                  segmentIndex: batchSegments[0].index,
                });
              }
              logger.info(
                {
                  batchSegmentIndices: segmentIndices,
                  signalCount: result.mergeSignals.length,
                },
                'Accumulated merge signals from batch',
              );
            }

            // Mark batch segments as completed
            for (const seg of batchSegments) {
              completedSegments.add(seg.index);
            }
            completedBatchCount++;

            await saveCheckpoint(documentId, {
              stage3Progress: {
                completedSegmentIndices: Array.from(completedSegments),
                extractedEntities,
                entityIdByName: Object.fromEntries(entityIdByName),
                aliasToEntityId: Object.fromEntries(aliasToEntityId),
                mergeSignals: accumulatedMergeSignals,
              },
            });

            // Check for pause/cancel after each batch
            await checkForInterruption(documentId);

            logger.debug(
              {
                batchSegmentIndices: segmentIndices,
                entityCount: runtimeRegistry.entries.size,
                completedBatches: completedBatchCount,
                totalBatches: batches.length,
              },
              'Batch extraction completed',
            );
          }
        } catch (error) {
          childLogger.error(
            {
              stage: 3,
              error: (error as any)?.message,
              stackTrace: (error as any)?.stack,
              partialResults: {
                batchesCompleted: completedBatchCount,
                totalBatches: batches?.length || 0,
                entitiesExtractedSoFar: extractedEntities.length,
                segmentsCompleted: completedSegments.size,
                totalSegments: segments.length,
              },
            },
            'Stage 3 failed with partial results',
          );
          throw error;
        }
      }

      const stage3DurationMs = Date.now() - stage3StartTime;
      const totalEntities = extractedEntities.reduce((sum) => sum + 1, 0);
      const totalFacets = extractedEntities.reduce(
        (sum, e) => sum + e.facets.length,
        0,
      );
      const totalMentions = extractedEntities.reduce(
        (sum, e) => sum + e.mentions.length,
        0,
      );

      logStageComplete(childLogger, 3, 'Entity Extraction', stage3DurationMs, {
        batchCount: totalBatchesProcessed,
        extractedCount: extractedEntities.length,
        uniqueEntities: runtimeRegistry.entries.size,
        totalEntities,
        totalFacets,
        totalMentions,
        avgFacetsPerEntity:
          totalEntities > 0 ? (totalFacets / totalEntities).toFixed(1) : 0,
        mergeSignals: accumulatedMergeSignals.length,
      });

      // VERBOSE MODE: Log actual entity names
      if (process.env.LOG_VERBOSE === 'true') {
        const { logEntityExtraction } = await import(
          '../../utils/logHelpers.js'
        );
        logEntityExtraction(childLogger, extractedEntities);
      }

      await saveCheckpoint(documentId, {
        lastStageCompleted: 3,
        stage3Progress: null,
        stage3Output: {
          extractedEntities,
          entityIdByName: Object.fromEntries(entityIdByName),
          aliasToEntityId: Object.fromEntries(aliasToEntityId),
          mergeSignals: accumulatedMergeSignals,
        },
      });
    } else if (checkpoint?.stage3Output) {
      extractedEntities = checkpoint.stage3Output.extractedEntities;
      entityIdByName = new Map(
        Object.entries(checkpoint.stage3Output.entityIdByName || {}),
      );
      aliasToEntityId = new Map(
        Object.entries(checkpoint.stage3Output.aliasToEntityId || {}),
      );
      accumulatedMergeSignals = checkpoint.stage3Output.mergeSignals || [];
      childLogger.info(
        { cachedCount: extractedEntities.length },
        'Skipping Stage 3 (using cached entities)',
      );
    } else {
      throw new Error(
        'Checkpoint inconsistency: Stage 3 skipped but no cached data',
      );
    }

    // Stage 4: Entity Creation with LLM-Determined Merges
    let resolvedEntities: ResolvedEntity[];

    if (shouldRunStage(checkpoint, 4)) {
      const stage4StartTime = Date.now();
      const stage4BatchId = changeLogService.generateBatchId();
      await checkForInterruption(documentId);
      broadcast(4, extractedEntities.length);
      logStageStart(childLogger, 4, 'Entity Resolution', {
        extractedCount: extractedEntities.length,
      });

      resolvedEntities = [];

      // Generate embeddings for entities that need them
      const entitiesNeedingEmbeddings = extractedEntities.filter(
        (e) => !e.existingMatch || e.existingMatch.confidence === 'low',
      );
      const entityTexts = entitiesNeedingEmbeddings.map(
        (entity) =>
          `${entity.name}: ${entity.facets.map((f) => f.content).join(', ')}`,
      );
      const entityEmbeddings =
        entityTexts.length > 0 ? await generateEmbeddings(entityTexts) : [];
      const embeddingByName = new Map<string, number[]>();
      entitiesNeedingEmbeddings.forEach((e, i) => {
        embeddingByName.set(e.name, entityEmbeddings[i]);
      });

      // Process accumulated merge signals
      if (accumulatedMergeSignals.length > 0) {
        logger.info(
          { documentId, signalCount: accumulatedMergeSignals.length },
          'Processing accumulated merge signals',
        );
        // For now, log signals for analysis (future: LLM review pass)
        for (const signal of accumulatedMergeSignals) {
          logger.debug(
            {
              extractedName: signal.extractedEntityName,
              registryName: signal.registryName,
              registryType: signal.registryType,
              confidence: signal.confidence,
              evidence: signal.evidence,
            },
            'Merge signal for future review',
          );
        }
      }

      // Create entities and facets in the database
      const uniqueEntityIds = new Set(entityIdByName.values());
      const createdEntityIds = new Set<string>();

      // Count entities by type for logging (including events)
      const entityTypeCount = new Map<string, number>();
      for (const entity of extractedEntities) {
        entityTypeCount.set(
          entity.type,
          (entityTypeCount.get(entity.type) || 0) + 1,
        );
      }

      logger.info(
        {
          documentId,
          extractedCount: extractedEntities.length,
          uniqueEntities: uniqueEntityIds.size,
          byType: Object.fromEntries(entityTypeCount),
        },
        'Stage 4: Creating entities in database (all types including events)',
      );
      broadcast(4, uniqueEntityIds.size, 'Creating entities...');

      for (const entityId of uniqueEntityIds) {
        // Find ALL extracted entities that map to this entityId
        const entityInstances = extractedEntities.filter(
          (e) => entityIdByName.get(e.name) === entityId,
        );
        if (entityInstances.length === 0) continue;

        const firstInstance = entityInstances[0];

        // Determine if this is a new entity or merging into existing
        const isExistingEntity =
          firstInstance.existingMatch &&
          firstInstance.existingMatch.confidence !== 'low';

        // Pick the primary name (first instance with no match, or most mentions)
        const primaryName = firstInstance.name;

        // Merge all facets from ALL instances
        const allFacets: FacetInput[] = [];
        for (const instance of entityInstances) {
          allFacets.push(...instance.facets);
        }
        const uniqueFacets = Array.from(
          new Map(allFacets.map((f) => [`${f.type}:${f.content}`, f])).values(),
        );

        // Build resolved entity for each instance
        for (const instance of entityInstances) {
          resolvedEntities.push({
            segmentId: instance.segmentId,
            name: instance.name,
            type: instance.type,
            documentOrder: instance.documentOrder,
            facets: instance.facets,
            mentions: instance.mentions,
            id: entityId,
            decision: isExistingEntity ? 'ADD_FACET' : 'NEW',
            targetEntityId: isExistingEntity ? entityId : undefined,
          });
        }

        if (!isExistingEntity) {
          // Create new entity
          const { created } = await createTrackedEntity(
            documentId,
            userId,
            {
              type: firstInstance.type,
              name: primaryName,
              description: '',
              mentions: [],
            },
            {
              stylePreset: documentStyle?.preset,
              stylePrompt: documentStyle?.prompt,
              existingId: entityId,
            },
            { batchId: stage4BatchId },
          );

          if (created) {
            // Create facets for newly created entity
            for (const facet of uniqueFacets) {
              const facetEmbedding = await generateEmbedding(facet.content);
              logger.debug(
                {
                  entityId,
                  facetType: facet.type,
                  facetContent: facet.content.substring(0, 50),
                  embeddingDim: facetEmbedding.length,
                },
                'Generated facet embedding',
              );
              await createTrackedFacet(entityId, facet, facetEmbedding, {
                batchId: stage4BatchId,
                entityName: primaryName,
              });
            }

            // Ensure at least one name facet exists (auto-create from primary name)
            const hasNameFacet = uniqueFacets.some((f) => f.type === 'name');
            if (!hasNameFacet) {
              const nameFacet: FacetInput = {
                type: 'name',
                content: primaryName,
              };
              const facetEmbedding = await generateEmbedding(nameFacet.content);
              logger.debug(
                {
                  entityId,
                  primaryName,
                  embeddingDim: facetEmbedding.length,
                },
                'Generated name facet embedding (auto-created)',
              );
              await createTrackedFacet(entityId, nameFacet, facetEmbedding, {
                batchId: stage4BatchId,
                entityName: primaryName,
              });
              logger.debug(
                { entityId, entityName: primaryName },
                'Auto-created name facet from primary name',
              );
            }

            // Recompute primary name from facets and update node
            await recomputeAndUpdatePrimaryName(entityId);

            createdEntityIds.add(entityId);

            // Set entity embedding
            const embedding = embeddingByName.get(primaryName);
            if (embedding) {
              await graphService.setNodeEmbedding(entityId, embedding);
            }
          }
        } else {
          // Add new facets to existing entity
          const existingFacets =
            await graphService.getFacetsForEntity(entityId);
          const existingFacetKeys = new Set(
            existingFacets.map((f) => `${f.type}:${f.content}`),
          );

          let addedNameFacet = false;
          for (const facet of uniqueFacets) {
            const key = `${facet.type}:${facet.content}`;
            if (!existingFacetKeys.has(key)) {
              const facetEmbedding = await generateEmbedding(facet.content);
              logger.debug(
                {
                  entityId,
                  facetType: facet.type,
                  facetContent: facet.content.substring(0, 50),
                  embeddingDim: facetEmbedding.length,
                },
                'Generated facet embedding for existing entity',
              );
              await createTrackedFacet(entityId, facet, facetEmbedding, {
                batchId: stage4BatchId,
                entityName: primaryName,
              });
              if (facet.type === 'name') {
                addedNameFacet = true;
              }
            }
          }

          // Recompute primary name if any name facets were added
          if (addedNameFacet) {
            await recomputeAndUpdatePrimaryName(entityId);
          }
        }

        // Create mentions for all instances
        for (const instance of entityInstances) {
          const segment = segments.find((s) => s.id === instance.segmentId);
          if (!segment) continue;

          const segmentText = documentContent.slice(segment.start, segment.end);

          for (const mention of instance.mentions) {
            const relativeIndex = segmentText.indexOf(mention.text);
            if (relativeIndex !== -1) {
              const absoluteStart = segment.start + relativeIndex;
              // Use idempotent create to avoid duplicates on pause/resume
              await mentionService.createFromAbsolutePositionIdempotent(
                entityId,
                documentId,
                absoluteStart,
                absoluteStart + mention.text.length,
                mention.text,
                versionNumber,
                segments,
                'extraction',
                100,
              );
            }
          }
        }

        // Recompute entity embedding with mention weights
        if (createdEntityIds.has(entityId) || isExistingEntity) {
          await recomputeEntityEmbeddingWithMentionWeights(entityId);
        }
      }

      const stage4DurationMs = Date.now() - stage4StartTime;
      logStageComplete(childLogger, 4, 'Entity Resolution', stage4DurationMs, {
        resolvedCount: resolvedEntities.length,
        newEntities: createdEntityIds.size,
        mergedEntities: uniqueEntityIds.size - createdEntityIds.size,
      });

      await saveCheckpoint(documentId, {
        lastStageCompleted: 4,
      });
    } else if (checkpoint) {
      resolvedEntities = extractedEntities
        .map((e) => ({
          ...e,
          id: entityIdByName.get(e.name) || '',
          decision: (e.existingMatch && e.existingMatch.confidence !== 'low'
            ? 'ADD_FACET'
            : 'NEW') as 'NEW' | 'ADD_FACET',
        }))
        .filter((e) => e.id);

      childLogger.info(
        { cachedEntities: entityIdByName.size },
        'Skipping Stage 4 (using cached entity mapping)',
      );
    } else {
      throw new Error(
        'Checkpoint inconsistency: Stage 4 skipped but no cached data',
      );
    }

    // Stages 5 & 6: Relationship Extraction (parallel)
    const allRelationships: Stage4RelationshipsResult['relationships'] = [];
    const stage5And6BatchId = changeLogService.generateBatchId();

    // Run Stages 5 and 6 in parallel if both need to run
    const needsStage5 = shouldRunStage(checkpoint, 5);
    const needsStage6 = shouldRunStage(checkpoint, 6);

    if (needsStage5 || needsStage6) {
      // Build alias lookup once for both stages
      const aliasesByEntityId = new Map<string, string[]>();
      for (const [alias, eid] of aliasToEntityId.entries()) {
        const existing = aliasesByEntityId.get(eid) || [];
        existing.push(alias);
        aliasesByEntityId.set(eid, existing);
      }

      const stage5And6Results = await Promise.all([
        // Stage 5: Intra-Segment Relationships
        (async () => {
          if (!needsStage5) {
            childLogger.info('Skipping Stage 5 (already completed)');
            return [];
          }

          const stage5StartTime = Date.now();
          await checkForInterruption(documentId);
          broadcast(5, entityIdByName.size);
          logStageStart(childLogger, 5, 'Intra-Segment Relationships', {
            entityCount: entityIdByName.size,
          });

          const intraSegmentRels: Stage4RelationshipsResult['relationships'] = [];

          // Build segment inputs with entities
          const segmentInputs = segments
            .map((segment, i) => {
              const segmentText = documentContent.slice(segment.start, segment.end);

              // Get resolved entities in this segment
              const entitiesInSegment = resolvedEntities.filter(
                (e) => e.segmentId === segment.id,
              );
              const uniqueEntitiesInSegment = Array.from(
                new Map(entitiesInSegment.map((e) => [e.id, e])).values(),
              );

              // Skip segments with <2 entities (no relationships possible)
              if (uniqueEntitiesInSegment.length < 2) return null;

              return {
                id: segment.id,
                index: i,
                text: segmentText,
                entities: uniqueEntitiesInSegment.map((e) => {
                  const allAliases = aliasesByEntityId.get(e.id) || [];
                  const otherAliases = allAliases.filter(
                    (a) => a.toLowerCase() !== e.name.toLowerCase(),
                  );
                  return {
                    id: e.id,
                    name: e.name,
                    type: e.type,
                    keyFacets: e.facets.slice(0, 3).map((f) => f.content),
                    aliases: otherAliases.length > 0 ? otherAliases : undefined,
                  };
                }),
              };
            })
            .filter((s): s is NonNullable<typeof s> => s !== null);

          if (segmentInputs.length === 0) {
            logger.info(
              { documentId },
              'No segments with 2+ entities, skipping intra-segment relationships',
            );
          } else {
            // Calculate batches using budget calculator
            const modelConfig = getTextModelConfig('gemini-2.5-flash');
            const { batchedRelationshipConfig } = await import(
              '../contextBudget/index.js'
            );
            const batches = calculateAllBatches({
              modelConfig,
              operationConfig: batchedRelationshipConfig,
              items: segmentInputs,
              overlapSize: 0,
            });

            logger.info(
              {
                documentId,
                totalSegments: segments.length,
                segmentsWithRelationships: segmentInputs.length,
                batchCount: batches.length,
                batchSizes: batches.map((b) => b.includedCount),
              },
              'Calculated relationship extraction batches',
            );

            // Get document summary for context
            const [doc] = await db
              .select({ summary: documents.summary })
              .from(documents)
              .where(eq(documents.id, documentId))
              .limit(1);

            // Import batch extraction function
            const { extractRelationshipsFromBatch } = await import(
              '../gemini/client.js'
            );

            // Process all batches using reusable helper
            const relationships = await processBatchesInParallel(
              batches,
              (items) =>
                extractRelationshipsFromBatch(
                  items,
                  userId,
                  documentId,
                  doc?.summary ?? undefined,
                ),
              broadcast,
              5,
              entityIdByName.size,
            );

            intraSegmentRels.push(...relationships);
          }

          const stage5DurationMs = Date.now() - stage5StartTime;
          logStageComplete(
            childLogger,
            6,
            'Intra-Segment Relationships',
            stage5DurationMs,
            {
              relationshipCount: intraSegmentRels.length,
            },
          );

          await saveCheckpoint(documentId, { lastStageCompleted: 5 });
          return intraSegmentRels;
        })(),

        // Stage 6: Cross-Segment Relationships
        (async () => {
          if (!needsStage6) {
            childLogger.info('Skipping Stage 6 (already completed)');
            return [];
          }

          const stage6StartTime = Date.now();
          await checkForInterruption(documentId);
          broadcast(6, entityIdByName.size);
          logStageStart(childLogger, 6, 'Cross-Segment Relationships', {
            entityCount: entityIdByName.size,
          });

          const crossSegmentRels: Stage4RelationshipsResult['relationships'] = [];

          // Build entity list with segment associations
          const entityWithSegments: EntityWithSegments[] = [];
          for (const [name, id] of entityIdByName) {
            const instances = resolvedEntities.filter((e) => e.name === name);
            const segmentIds = [...new Set(instances.map((e) => e.segmentId))];
            const keyFacets =
              instances[0]?.facets.slice(0, 3).map((f) => f.content) || [];

            // Get aliases for this entity, excluding the primary name
            const allAliases = aliasesByEntityId.get(id) || [];
            const otherAliases = allAliases.filter(
              (a) => a.toLowerCase() !== name.toLowerCase(),
            );

            entityWithSegments.push({
              id,
              name,
              type: instances[0]?.type || 'other',
              segmentIds,
              keyFacets,
              aliases: otherAliases.length > 0 ? otherAliases : undefined,
            });
          }

          // Only run cross-segment if we have entities in multiple segments
          const entitiesInMultipleSegments = entityWithSegments.filter(
            (e) => e.segmentIds.length > 1,
          );

          if (entitiesInMultipleSegments.length === 0) {
            logger.info(
              { documentId },
              'No entities in multiple segments, skipping cross-segment relationships',
            );
          } else {
            // Calculate batches using budget calculator (same pattern as Stage 5)
            const modelConfig = getTextModelConfig('gemini-2.5-flash-lite');
            const { crossSegmentRelationshipConfig } = await import(
              '../contextBudget/index.js'
            );
            const batches = calculateAllBatches({
              modelConfig,
              operationConfig: crossSegmentRelationshipConfig,
              items: entitiesInMultipleSegments,
              overlapSize: 0,
            });

            logger.info(
              {
                documentId,
                totalEntities: entityWithSegments.length,
                multiSegmentEntities: entitiesInMultipleSegments.length,
                batchCount: batches.length,
              },
              `Processing cross-segment relationships in ${batches.length} batch(es)`,
            );

            // Get document summary for context
            const [doc] = await db
              .select({ summary: documents.summary })
              .from(documents)
              .where(eq(documents.id, documentId))
              .limit(1);

            // Process all batches using reusable helper
            const relationships = await processBatchesInParallel(
              batches,
              (items) =>
                extractCrossSegmentRelationships(
                  doc?.summary ?? documentTitle
                    ? `Document: "${documentTitle}"`
                    : undefined,
                  items.map((item) => ({
                    ...item,
                    segmentIds: item.segmentIds ?? [],
                  })),
                  [],
                  userId,
                  documentId,
                ),
              broadcast,
              6,
              entityIdByName.size,
            );

            crossSegmentRels.push(...relationships);
          }

          const stage6DurationMs = Date.now() - stage6StartTime;
          logStageComplete(
            childLogger,
            7,
            'Cross-Segment Relationships',
            stage6DurationMs,
            {
              relationshipCount: crossSegmentRels.length,
            },
          );

          await saveCheckpoint(documentId, { lastStageCompleted: 6 });
          return crossSegmentRels;
        })(),
      ]);

      // Merge results from both stages
      const [intraSegmentRels, crossSegmentRels] = stage5And6Results;
      allRelationships.push(...intraSegmentRels, ...crossSegmentRels);

      // Write all relationships to graph (idempotent)
      for (const rel of allRelationships) {
        try {
          await createTrackedEdge(
            rel.fromId,
            rel.toId,
            rel.edgeType as StoryEdgeType,
            rel.description,
            { strength: rel.strength },
            { batchId: stage5And6BatchId },
          );
        } catch (err: any) {
          if (!err?.message?.includes('would create a cycle')) {
            childLogger.warn(
              { rel, error: err },
              'Failed to create relationship',
            );
          }
        }
      }

      logger.info(
        {
          intraSegmentCount: intraSegmentRels.length,
          crossSegmentCount: crossSegmentRels.length,
          totalCount: allRelationships.length,
        },
        'Relationship extraction complete (parallel execution)',
      );
    }


    // Stage 7: Higher-Order Analysis
    let higherOrderResult: Stage5HigherOrderResult | null = null;
    const stage7BatchId = changeLogService.generateBatchId();

    if (shouldRunStage(checkpoint, 7)) {
      const stage7StartTime = Date.now();
      await checkForInterruption(documentId);
      broadcast(7, entityIdByName.size);
      logStageStart(childLogger, 7, 'Higher-Order Analysis', {
        entityCount: entityIdByName.size,
      });

      // Get events and characters for thread/arc analysis
      const events: Array<{
        id: string;
        name: string;
        documentOrder: number;
        connectedCharacterIds: string[];
        causalEdges: Array<{
          type: 'CAUSES' | 'ENABLES' | 'PREVENTS';
          targetId: string;
          strength: number;
        }>;
      }> = [];

      const characters: Array<{
        id: string;
        name: string;
        participatesInEventIds: string[];
        stateFacetsBySegment: Array<{
          segmentIndex: number;
          states: string[];
        }>;
      }> = [];

      for (const [name, id] of entityIdByName) {
        const instances = resolvedEntities.filter((e) => e.name === name);
        const entityType = instances[0]?.type;

        if (entityType === 'event') {
          // Get causal edges
          const connections = await graphService.getConnectionsFromNode(id);
          const causalEdges = connections
            .filter((c) =>
              ['CAUSES', 'ENABLES', 'PREVENTS'].includes(c.edgeType),
            )
            .map((c) => ({
              type: c.edgeType as 'CAUSES' | 'ENABLES' | 'PREVENTS',
              targetId: c.toNodeId,
              strength: c.strength || 0.5,
            }));

          // Get connected characters
          const participates = connections.filter(
            (c) => c.edgeType === 'PARTICIPATES_IN',
          );
          const connectedCharacterIds = participates.map((c) => c.fromNodeId);

          events.push({
            id,
            name,
            documentOrder: instances[0]?.documentOrder || 0,
            connectedCharacterIds,
            causalEdges,
          });
        } else if (entityType === 'character') {
          // Get state facets by segment
          const stateFacetsBySegment: Array<{
            segmentIndex: number;
            states: string[];
          }> = [];

          for (const instance of instances) {
            const segmentIndex = segments.findIndex(
              (s) => s.id === instance.segmentId,
            );
            const states = instance.facets
              .filter((f) => f.type === 'state')
              .map((f) => f.content);

            if (states.length > 0) {
              stateFacetsBySegment.push({ segmentIndex, states });
            }
          }

          // Get events this character participates in
          const connections = await graphService.getConnectionsFromNode(id);
          const participatesIn = connections
            .filter((c) => c.edgeType === 'PARTICIPATES_IN')
            .map((c) => c.toNodeId);

          characters.push({
            id,
            name,
            participatesInEventIds: participatesIn,
            stateFacetsBySegment,
          });
        }
      }

      // Sort events by document order
      events.sort((a, b) => a.documentOrder - b.documentOrder);

      // Detect thread candidates algorithmically (connected components in causal graph)
      const threadCandidates = detectThreadCandidates(events, characters);

      if (events.length >= 2) {
        higherOrderResult = await analyzeHigherOrder(
          events,
          characters,
          threadCandidates,
          userId,
          documentId,
          documentTitle,
        );

        // Create narrative threads (idempotent)
        for (const thread of higherOrderResult.narrativeThreads) {
          const { id: threadId, created } = await createTrackedThread(
            documentId,
            userId,
            {
              name: thread.name,
              isPrimary: thread.isPrimary,
              eventNames: [],
            },
            { batchId: stage7BatchId },
          );

          if (created) {
            for (const [i, eventId] of thread.eventIds.entries()) {
              await graphService.linkEventToThread(eventId, threadId, i);
            }
          }
        }

        // Process character arcs from flattened arcPhases
        if (
          higherOrderResult.arcPhases &&
          higherOrderResult.arcPhases.length > 0
        ) {
          await processCharacterArcs(
            higherOrderResult.arcPhases,
            documentId,
            userId,
            entityIdByName,
            events,
            stage7BatchId,
          );
        }
      }

      const stage7DurationMs = Date.now() - stage7StartTime;
      logStageComplete(
        childLogger,
        8,
        'Higher-Order Analysis',
        stage7DurationMs,
        {
          threadCount: higherOrderResult?.narrativeThreads.length || 0,
          arcCount: new Set(
            (higherOrderResult?.arcPhases || []).map((p) => p.characterId),
          ).size,
          arcPhaseCount: higherOrderResult?.arcPhases?.length || 0,
        },
      );

      await saveCheckpoint(documentId, { lastStageCompleted: 7 });
    } else {
      childLogger.info('Skipping Stage 7 (already completed)');
    }

    // Stage 8: CharacterState facet attachment
    const stage8BatchId = changeLogService.generateBatchId();
    if (shouldRunStage(checkpoint, 8)) {
      const stage8StartTime = Date.now();
      await checkForInterruption(documentId);
      broadcast(8, entityIdByName.size, 'Processing character state facets...');
      logStageStart(childLogger, 8, 'CharacterState Facet Attachment', {
        entityCount: entityIdByName.size,
      });

      await processStateFacetAttachment(
        documentId,
        userId,
        entityIdByName,
        stage8BatchId,
      );

      const stage8DurationMs = Date.now() - stage8StartTime;
      logStageComplete(
        childLogger,
        9,
        'CharacterState Facet Attachment',
        stage8DurationMs,
        {},
      );

      await saveCheckpoint(documentId, { lastStageCompleted: 8 });
    } else {
      childLogger.info('Skipping Stage 8 (already completed)');
    }

    // Stage 9: Conflict Detection
    if (shouldRunStage(checkpoint, 9)) {
      const stage9StartTime = Date.now();
      await checkForInterruption(documentId);
      broadcast(9, entityIdByName.size, 'Detecting conflicts...');
      logStageStart(childLogger, 9, 'Conflict Detection', {
        entityCount: entityIdByName.size,
      });

      await detectFacetConflicts(documentId, userId);

      const stage9DurationMs = Date.now() - stage9StartTime;
      logStageComplete(
        childLogger,
        10,
        'Conflict Detection',
        stage9DurationMs,
        {},
      );

      await saveCheckpoint(documentId, { lastStageCompleted: 9 });
    } else {
      childLogger.info('Skipping Stage 9 (already completed)');
    }

    await generateEntityDescriptions(documentId, userId, entityIdByName);

    // Clear checkpoint on successful completion
    await clearCheckpoint(documentId);

    // Count unique characters with arcs
    const uniqueCharactersWithArcs = new Set(
      (higherOrderResult?.arcPhases || []).map((p) => p.characterId),
    );

    const pipelineDurationMs = Date.now() - pipelineStartTime;
    childLogger.info(
      {
        durationMs: pipelineDurationMs,
        entityCount: entityIdByName.size,
        relationshipCount: allRelationships.length,
        threadCount: higherOrderResult?.narrativeThreads.length || 0,
        arcCount: uniqueCharactersWithArcs.size,
      },
      'Analysis pipeline completed',
    );

    return {
      entityCount: entityIdByName.size,
      relationshipCount: allRelationships.length,
      threadCount: higherOrderResult?.narrativeThreads.length || 0,
      arcCount: uniqueCharactersWithArcs.size,
    };
  },
};

/**
 * Detect thread candidates by finding connected components in the causal graph.
 */
function detectThreadCandidates(
  events: Array<{
    id: string;
    causalEdges: Array<{ targetId: string }>;
    connectedCharacterIds: string[];
  }>,
  _characters: Array<{ id: string; participatesInEventIds: string[] }>,
): Array<{ eventIds: string[]; characterIds: string[] }> {
  if (events.length === 0) return [];

  // Build adjacency list for events via causal edges
  const adj = new Map<string, Set<string>>();
  for (const event of events) {
    adj.set(event.id, new Set());
  }

  for (const event of events) {
    for (const edge of event.causalEdges) {
      adj.get(event.id)?.add(edge.targetId);
      if (!adj.has(edge.targetId)) {
        adj.set(edge.targetId, new Set());
      }
      adj.get(edge.targetId)?.add(event.id);
    }
  }

  // Find connected components
  const visited = new Set<string>();
  const components: Array<{ eventIds: string[]; characterIds: string[] }> = [];

  for (const event of events) {
    if (visited.has(event.id)) continue;

    const component: string[] = [];
    const stack = [event.id];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;

      visited.add(current);
      component.push(current);

      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    // Find characters connected to events in this component
    const componentCharacters = new Set<string>();
    for (const eventId of component) {
      const event = events.find((e) => e.id === eventId);
      if (event) {
        for (const charId of event.connectedCharacterIds) {
          componentCharacters.add(charId);
        }
      }
    }

    components.push({
      eventIds: component,
      characterIds: Array.from(componentCharacters),
    });
  }

  return components;
}

/**
 * Process character arcs from flattened arcPhases.
 * Groups by characterId, creates CharacterState nodes, Arc nodes, and edges.
 */
async function processCharacterArcs(
  arcPhases: Stage5HigherOrderResult['arcPhases'],
  documentId: string,
  userId: string,
  _entityIdByName: Map<string, string>,
  events: Array<{ id: string; documentOrder: number }>,
  batchId: string,
): Promise<void> {
  // Group phases by characterId
  const phasesByCharacter = new Map<string, typeof arcPhases>();
  for (const phase of arcPhases) {
    const existing = phasesByCharacter.get(phase.characterId) || [];
    existing.push(phase);
    phasesByCharacter.set(phase.characterId, existing);
  }

  // Process each character's arc
  for (const [characterId, phases] of phasesByCharacter) {
    // Sort phases by phaseIndex
    phases.sort((a, b) => a.phaseIndex - b.phaseIndex);

    if (phases.length === 0) continue;

    // Get arcType from first phase (should be consistent)
    const arcType = phases[0].arcType;

    // Create the Arc node
    const arcId = await createTrackedArc(
      characterId,
      documentId,
      userId,
      {
        arcType,
      },
      { batchId },
    );

    // Create CharacterState nodes for each phase
    const stateIds: string[] = [];

    for (const phase of phases) {
      // Compute document order and causal order from trigger event
      let documentOrder = phase.phaseIndex;
      let causalOrder = phase.phaseIndex;

      if (phase.triggerEventId) {
        const triggerEvent = events.find((e) => e.id === phase.triggerEventId);
        if (triggerEvent) {
          documentOrder = triggerEvent.documentOrder;
          causalOrder = triggerEvent.documentOrder; // Could compute differently if needed
        }
      }

      // Create CharacterState node
      const stateId = await createTrackedState(
        characterId,
        documentId,
        userId,
        {
          name: phase.phaseName,
          phaseIndex: phase.phaseIndex,
          documentOrder,
          causalOrder,
        },
        { batchId },
      );

      stateIds.push(stateId);

      // Link state to arc
      await graphService.linkStateToArc(stateId, arcId, phase.phaseIndex);

      // Link character to state
      await graphService.linkCharacterToState(characterId, stateId);

      // Link state to facets mentioned in stateFacets
      // Find matching facets from the entity's existing facets
      const entityFacets = await graphService.getFacetsForEntity(characterId);
      for (const facetContent of phase.stateFacets) {
        const matchingFacet = entityFacets.find(
          (f) =>
            f.content.toLowerCase().includes(facetContent.toLowerCase()) ||
            facetContent.toLowerCase().includes(f.content.toLowerCase()),
        );
        if (matchingFacet) {
          await graphService.linkStateToFacet(stateId, matchingFacet.id);
        }
      }

      // Compute and set embedding for the state (sum of linked facet embeddings)
      const stateFacets = await graphService.getFacetsForState(stateId);
      if (stateFacets.length > 0 && stateFacets.some((f) => f.embedding)) {
        const embeddings = stateFacets
          .filter((f) => f.embedding)
          .map((f) => f.embedding!);

        if (embeddings.length > 0) {
          const sumEmbedding = embeddings[0].map(
            (_, i) =>
              embeddings.reduce((sum, e) => sum + e[i], 0) / embeddings.length,
          );
          await graphService.setCharacterStateEmbedding(stateId, sumEmbedding);
        }
      }
    }

    // Create CHANGES_TO edges between consecutive states
    for (let i = 0; i < stateIds.length - 1; i++) {
      const fromStateId = stateIds[i];
      const toStateId = stateIds[i + 1];
      const toPhase = phases[i + 1];

      await createTrackedStateTransition(
        fromStateId,
        toStateId,
        {
          triggerEventId: toPhase.triggerEventId,
          gapDetected: toPhase.triggerEventId === null && i > 0,
        },
        { batchId, characterId },
      );
    }

    logger.info(
      { characterId, arcId, stateCount: stateIds.length, arcType },
      'Character arc processed',
    );
  }
}

/**
 * Stage 7: Process state facet attachment.
 *
 * For Character entities with `state` type facets:
 * 1. If no CharacterState exists, create a default one
 * 2. Move state facets from Entity to CharacterState based on position
 *
 * Position-based assignment: Each state facet is assigned to the CharacterState
 * whose validity window (documentOrder to next state's documentOrder) contains
 * the facet's estimated position. Since facets don't directly store position,
 * we use the entity's first mention position as a baseline estimate. For entities
 * with multiple states, we distribute facets based on state order when exact
 * position matching isn't possible.
 *
 * This ensures state facets are attached to CharacterState (phase-bounded)
 * rather than Entity (permanent).
 */
async function processStateFacetAttachment(
  documentId: string,
  userId: string,
  _entityIdByName: Map<string, string>,
  batchId: string,
): Promise<void> {
  // Get document segments for position calculations
  const [doc] = await db
    .select({ segmentSequence: documents.segmentSequence })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  const segments = (doc?.segmentSequence as Segment[]) || [];

  // Get all character entities
  const allNodes = await graphStoryNodesRepository.getActiveNodes(
    documentId,
    userId,
  );
  const characterNodes = allNodes.filter((n) => n.type === 'character');

  let movedFacetCount = 0;
  let createdStateCount = 0;

  for (const character of characterNodes) {
    // Get state facets attached to this character entity
    const stateFacets = await graphService.getStateFacetsForEntity(
      character.id,
    );

    if (stateFacets.length === 0) {
      continue;
    }

    // Check if character already has CharacterStates
    const existingStates = await graphService.getCharacterStates(character.id);

    if (existingStates.length === 0) {
      // No states exist - create a default CharacterState
      const stateId = await createTrackedState(
        character.id,
        documentId,
        userId,
        {
          name: `${character.name}_initial_state`,
          phaseIndex: 0,
          documentOrder: 0,
          causalOrder: 0,
        },
        { batchId, characterName: character.name },
      );

      // Link character to this state
      await graphService.linkCharacterToState(character.id, stateId);

      // Move all state facets to this CharacterState
      for (const facet of stateFacets) {
        await graphService.moveFacetToState(character.id, facet.id, stateId);
        movedFacetCount++;
      }

      createdStateCount++;

      logger.debug(
        {
          characterId: character.id,
          characterName: character.name,
          stateId,
          facetCount: stateFacets.length,
        },
        'Created CharacterState and moved state facets',
      );
    } else if (existingStates.length === 1) {
      // Single state - all facets go to it (simple case)
      const onlyState = existingStates[0];
      for (const facet of stateFacets) {
        await graphService.moveFacetToState(
          character.id,
          facet.id,
          onlyState.id,
        );
        movedFacetCount++;
      }

      logger.debug(
        {
          characterId: character.id,
          characterName: character.name,
          stateId: onlyState.id,
          facetCount: stateFacets.length,
        },
        'Moved state facets to single CharacterState',
      );
    } else {
      // Multiple states exist - try position-based matching
      // Sort states by documentOrder to create validity windows
      const sortedStates = [...existingStates].sort(
        (a, b) => a.documentOrder - b.documentOrder,
      );

      // Get character's mentions to estimate facet positions
      const characterMentions =
        await mentionService.getByNodeIdWithAbsolutePositions(
          character.id,
          segments,
        );

      // For each state facet, find the appropriate state based on position
      for (const facet of stateFacets) {
        // Try to find a mention linked to this facet (if available)
        const facetMentions = characterMentions.filter(
          (m) => m.facetId === facet.id,
        );

        let targetState = sortedStates[sortedStates.length - 1]; // Default to last state

        if (facetMentions.length > 0) {
          // Use the first facet mention's position
          const facetPosition = facetMentions[0].absoluteStart;
          targetState = findStateForPosition(sortedStates, facetPosition);
        } else if (characterMentions.length > 0) {
          // Fall back to character's first mention as a baseline
          // This is imprecise but better than always using the last state
          const firstMention = characterMentions.reduce(
            (min, m) => (m.absoluteStart < min.absoluteStart ? m : min),
            characterMentions[0],
          );

          // Use first mention to at least get the initial state right
          // For facets without explicit position, assign to first state
          // (assumption: most state facets describe initial/current state)
          targetState = findStateForPosition(
            sortedStates,
            firstMention.absoluteStart,
          );
        }

        await graphService.moveFacetToState(
          character.id,
          facet.id,
          targetState.id,
        );
        movedFacetCount++;
      }

      logger.debug(
        {
          characterId: character.id,
          characterName: character.name,
          stateCount: sortedStates.length,
          facetCount: stateFacets.length,
        },
        'Distributed state facets across CharacterStates by position',
      );
    }
  }

  logger.info(
    {
      documentId,
      charactersProcessed: characterNodes.length,
      statesCreated: createdStateCount,
      facetsMoved: movedFacetCount,
    },
    'State facet attachment complete',
  );
}

/**
 * Find the CharacterState whose validity window contains the given position.
 * States are sorted by documentOrder. A state's validity window runs from
 * its documentOrder to the next state's documentOrder (or infinity for last state).
 */
function findStateForPosition<T extends { id: string; documentOrder: number }>(
  sortedStates: T[],
  position: number,
): T {
  for (let i = 0; i < sortedStates.length; i++) {
    const state = sortedStates[i];
    const nextState = sortedStates[i + 1];

    // Check if position falls within this state's validity window
    if (position >= state.documentOrder) {
      if (!nextState || position < nextState.documentOrder) {
        return state;
      }
    }
  }

  // Position is before first state - return first state
  return sortedStates[0];
}

/**
 * Character context for facet conflict detection.
 * Provides state-centric fabula timeline with events, transitions, and edges.
 */
interface CharacterContext {
  entityId: string;
  entityName: string;
  entityType: string;
  description: string | null;
  aliases: string[] | null;

  states: Array<{
    id: string;
    name: string;
    phaseIndex: number;
    causalOrder: number;
    documentOrder: number;
    segmentIds: string[];
    segmentSummary: string | null;
    facets: Array<{
      id: string;
      type: FacetType;
      content: string;
      mentionCount: number;
      segmentRange: string;
    }>;
    events: Array<{
      id: string;
      name: string;
      description: string | null;
      causalOrder: number;
      outgoingEdges: Array<{
        type: StoryEdgeType;
        toNodeName: string;
      }>;
    }>;
    transitionTo: {
      toStateId: string;
      toStateName: string;
      triggerEventId: string | null;
      triggerEventName: string | null;
      triggerEventDescription: string | null;
      gapDetected: boolean;
      causationQuality?: {
        level: 'strong' | 'weak' | 'none';
        reason?: string;
      } | null;
    } | null;
  }>;

  permanentFacets: Array<{
    id: string;
    type: FacetType;
    content: string;
    mentionCount: number;
    statesPresent: number[];
    firstPosition?: number | null;
    lastPosition?: number | null;
  }>;

  arcs: Array<{
    id: string;
    name: string;
    arcType: ArcType;
    summary: string | null;
    stateIndices: number[];
  }>;

  causalEdges: Array<{
    edgeType: 'CAUSES' | 'ENABLES' | 'PREVENTS' | 'HAPPENS_BEFORE';
    toNodeName: string;
    description: string | null;
  }>;

  narrativeEdges: Array<{
    edgeType: StoryEdgeType;
    toNodeName: string;
    description: string | null;
  }>;

  allFacets: StoredFacet[];
}

/**
 * Conflict type taxonomy.
 * Based on TDD 2026-02-23_temporal-state-design.md Section 6.
 */
type ConflictType =
  | 'temporal_change' // Has intervening event or CharacterState transition
  | 'arc_divergence' // Different arcs, not a conflict
  | 'true_inconsistency' // No explanation, route to review queue
  | 'perspective_difference'; // Different narrators (future)

interface DetectedConflict {
  entityId: string;
  entityName: string;
  facetType: FacetType;
  facetA: { id: string; content: string };
  facetB: { id: string; content: string };
  conflictType: ConflictType;
  reasoning: string;
}

/**
 * Group facets by type.
 */
function groupFacetsByType(
  facets: StoredFacet[],
): Map<FacetType, StoredFacet[]> {
  const map = new Map<FacetType, StoredFacet[]>();
  for (const facet of facets) {
    const existing = map.get(facet.type) || [];
    existing.push(facet);
    map.set(facet.type, existing);
  }
  return map;
}

function assessCausationQuality(description: string | null): {
  level: 'strong' | 'weak' | 'none';
  reason?: string;
} {
  if (!description) return { level: 'none' };

  const desc = description.toLowerCase().trim();

  const weakPatterns = [
    /^an? (event|thing|action|change) (occurs?|happens?)/i,
    /^something (occurs?|happens?)/i,
    /^(it|this) (occurs?|happens?)/i,
    /^(the )?(character|person|entity)/i,
    /^[a-z]+ changes?$/i,
    /^transition/i,
  ];

  const isWeak = weakPatterns.some((pattern) => pattern.test(desc));
  const isTooShort = desc.length < 15;
  const hasNoVerb =
    !/(do|does|is|are|was|were|have|has|had|can|will|would|should|may|might|must)/i.test(
      desc,
    );

  if (isWeak || (isTooShort && hasNoVerb)) {
    return { level: 'weak', reason: 'Generic or vague description' };
  }

  return { level: 'strong' };
}

/**
 * Build character context with state-centric fabula timeline.
 */
async function buildCharacterContext(
  entity: StoredStoryNode,
  segments: Segment[],
  causalOrderMap: Map<string, number>,
  documentId: string,
  userId: string,
): Promise<CharacterContext> {
  const states = await graphService.getCharacterStates(entity.id);
  const transitions = await graphService.getStateTransitions(entity.id);
  const arcs = await graphService.getCharacterArcs(entity.id);

  if (states.length === 0) {
    return buildSimplifiedContext(
      entity,
      segments,
      causalOrderMap,
      documentId,
      userId,
    );
  }

  const transitionMap = new Map(transitions.map((t) => [t.fromStateId, t]));

  const allDocEvents = await graphStoryNodesRepository.getActiveNodes(
    documentId,
    userId,
  );
  const events = allDocEvents.filter((n) => n.type === 'event');

  const stateContexts = [];
  const allStateFacetIds = new Set<string>();

  const allStateFacets = await Promise.all(
    states.map((s) => graphService.getFacetsForState(s.id)),
  );

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const stateFacets = allStateFacets[i];

    const facetsWithMentions = await Promise.all(
      stateFacets.map(async (facet) => {
        const mentions = await mentionService.getByNodeIdWithAbsolutePositions(
          facet.id,
          segments,
        );
        const keyMentions = mentions.filter((m) => m.source === 'extraction');

        const segmentIndices = keyMentions
          .map((m) => segments.findIndex((s) => s.id === m.segmentId))
          .filter((idx) => idx !== -1)
          .sort((a, b) => a - b);

        const segmentRange =
          segmentIndices.length > 0
            ? segmentIndices.length === 1
              ? `${segmentIndices[0]}`
              : `${segmentIndices[0]}-${segmentIndices[segmentIndices.length - 1]}`
            : 'unknown';

        return {
          id: facet.id,
          type: facet.type,
          content: facet.content,
          mentionCount: keyMentions.length,
          segmentRange,
        };
      }),
    );

    for (const f of stateFacets) {
      allStateFacetIds.add(f.id);
    }

    const stateEvents = events.filter((e) => {
      const eCausal = causalOrderMap.get(e.id);
      if (!eCausal) return false;

      const stateStart = state.causalOrder;
      const stateEnd = transitionMap.get(state.id)?.toStateId
        ? (states.find((s) => s.id === transitionMap.get(state.id)!.toStateId)
            ?.causalOrder ?? Infinity)
        : Infinity;

      return eCausal >= stateStart && eCausal < stateEnd;
    });

    const eventsWithEdges = await Promise.all(
      stateEvents.map(async (event) => {
        const edges = await graphService.getConnectionsFromNode(event.id);
        const outgoingEdges = edges.map((e) => ({
          type: e.edgeType,
          toNodeName:
            allDocEvents.find((n) => n.id === e.toNodeId)?.name ?? 'unknown',
        }));

        return {
          id: event.id,
          name: event.name,
          description: event.description,
          causalOrder: causalOrderMap.get(event.id) ?? state.causalOrder,
          outgoingEdges,
        };
      }),
    );

    const transition = transitionMap.get(state.id);
    let transitionInfo = null;

    if (transition) {
      const toState = states.find((s) => s.id === transition.toStateId);
      let triggerEvent = null;
      let causationQuality = null;

      if (transition.triggerEventId) {
        triggerEvent = events.find((e) => e.id === transition.triggerEventId);
        causationQuality = assessCausationQuality(
          triggerEvent?.description ?? null,
        );
      }

      transitionInfo = {
        toStateId: transition.toStateId,
        toStateName: toState?.name ?? 'unknown',
        triggerEventId: transition.triggerEventId,
        triggerEventName: triggerEvent?.name ?? null,
        triggerEventDescription: triggerEvent?.description ?? null,
        gapDetected: transition.gapDetected,
        causationQuality,
      };
    }

    const stateSegmentIndices = facetsWithMentions
      .flatMap((f) => {
        const range = f.segmentRange.split('-');
        const start = parseInt(range[0]);
        const end = range.length > 1 ? parseInt(range[1]) : start;
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      })
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);

    const segmentIds = stateSegmentIndices
      .map((idx) => segments[idx]?.id)
      .filter(Boolean);
    const firstSegment =
      stateSegmentIndices.length > 0
        ? segments[stateSegmentIndices[0]]
        : undefined;

    stateContexts.push({
      id: state.id,
      name: state.name,
      phaseIndex: state.phaseIndex,
      causalOrder: state.causalOrder,
      documentOrder: state.documentOrder,
      segmentIds,
      segmentSummary: firstSegment?.summary ?? null,
      facets: facetsWithMentions,
      events: eventsWithEdges,
      transitionTo: transitionInfo,
    });
  }

  const allEntityFacets = await graphService.getFacetsForEntity(entity.id);
  const permanentFacets = allEntityFacets.filter(
    (f) => !allStateFacetIds.has(f.id),
  );

  const permanentFacetsWithContext = await Promise.all(
    permanentFacets.map(async (facet) => {
      const mentions = await mentionService.getByNodeIdWithAbsolutePositions(
        facet.id,
        segments,
      );
      const keyMentions = mentions.filter((m) => m.source === 'extraction');

      const statesPresent = states
        .filter((state) => {
          const nextState = states[state.phaseIndex + 1];
          const stateEnd = nextState?.documentOrder ?? Infinity;

          return keyMentions.some(
            (m) =>
              m.absoluteStart >= state.documentOrder &&
              m.absoluteStart < stateEnd,
          );
        })
        .map((s) => s.phaseIndex);

      return {
        id: facet.id,
        type: facet.type,
        content: facet.content,
        mentionCount: keyMentions.length,
        statesPresent,
      };
    }),
  );

  const arcsWithStates = await Promise.all(
    arcs.map(async (arc) => {
      const arcStates = await graphService.getArcStates(arc.id);
      const stateIndices = arcStates
        .map((s) => s.phaseIndex)
        .sort((a, b) => a - b);

      return {
        id: arc.id,
        name: arc.name,
        arcType: arc.arcType,
        summary: arc.summary,
        stateIndices,
      };
    }),
  );

  const edges = await graphService.getConnectionsFromNode(entity.id);

  const causalEdges = edges
    .filter((e) =>
      ['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE'].includes(e.edgeType),
    )
    .map((e) => ({
      edgeType: e.edgeType as
        | 'CAUSES'
        | 'ENABLES'
        | 'PREVENTS'
        | 'HAPPENS_BEFORE',
      toNodeName:
        allDocEvents.find((n) => n.id === e.toNodeId)?.name ?? 'unknown',
      description: e.description,
    }));

  const narrativeEdges = edges
    .filter(
      (e) =>
        !['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE'].includes(
          e.edgeType,
        ),
    )
    .map((e) => ({
      edgeType: e.edgeType,
      toNodeName:
        allDocEvents.find((n) => n.id === e.toNodeId)?.name ?? 'unknown',
      description: e.description,
    }));

  return {
    entityId: entity.id,
    entityName: entity.name,
    entityType: entity.type,
    description: entity.description,
    aliases: entity.aliases,
    states: stateContexts,
    permanentFacets: permanentFacetsWithContext,
    arcs: arcsWithStates,
    causalEdges,
    narrativeEdges,
    allFacets: allEntityFacets,
  };
}

/**
 * Build simplified context for entities without CharacterStates.
 */
async function buildSimplifiedContext(
  entity: StoredStoryNode,
  segments: Segment[],
  _causalOrderMap: Map<string, number>,
  documentId: string,
  userId: string,
): Promise<CharacterContext> {
  const allFacets = await graphService.getFacetsForEntity(entity.id);

  const facetsWithPositions = await Promise.all(
    allFacets.map(async (facet) => {
      const mentions = await mentionService.getByNodeIdWithAbsolutePositions(
        facet.id,
        segments,
      );
      const keyMentions = mentions.filter((m) => m.source === 'extraction');

      const positions = keyMentions
        .map((m) => m.absoluteStart)
        .sort((a, b) => a - b);
      const firstPos = positions[0] ?? null;
      const lastPos = positions[positions.length - 1] ?? null;

      return {
        facet,
        firstPosition: firstPos,
        lastPosition: lastPos,
        mentionCount: keyMentions.length,
      };
    }),
  );

  const allDocEvents = await graphStoryNodesRepository.getActiveNodes(
    documentId,
    userId,
  );

  const edges = await graphService.getConnectionsFromNode(entity.id);
  const causalEdges = edges
    .filter((e) =>
      ['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE'].includes(e.edgeType),
    )
    .map((e) => ({
      edgeType: e.edgeType as
        | 'CAUSES'
        | 'ENABLES'
        | 'PREVENTS'
        | 'HAPPENS_BEFORE',
      toNodeName:
        allDocEvents.find((n) => n.id === e.toNodeId)?.name ?? 'unknown',
      description: e.description,
    }));

  const narrativeEdges = edges
    .filter(
      (e) =>
        !['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE'].includes(
          e.edgeType,
        ),
    )
    .map((e) => ({
      edgeType: e.edgeType,
      toNodeName:
        allDocEvents.find((n) => n.id === e.toNodeId)?.name ?? 'unknown',
      description: e.description,
    }));

  return {
    entityId: entity.id,
    entityName: entity.name,
    entityType: entity.type,
    description: entity.description,
    aliases: entity.aliases,
    states: [],
    permanentFacets: facetsWithPositions.map((f) => ({
      id: f.facet.id,
      type: f.facet.type,
      content: f.facet.content,
      mentionCount: f.mentionCount,
      statesPresent: [],
      firstPosition: f.firstPosition,
      lastPosition: f.lastPosition,
    })),
    arcs: [],
    causalEdges,
    narrativeEdges,
    allFacets,
  };
}

/**
 * Build context-aware prompt for facet conflict detection.
 */
function buildContextPrompt(
  entityName: string,
  facetType: FacetType,
  facets: StoredFacet[],
  context: CharacterContext,
): string {
  if (context.states.length === 0 && context.permanentFacets.length === 0) {
    logger.warn(
      { entityId: context.entityId },
      'No state or facet context available - prompt will be minimal',
    );
  }

  let prompt = '';

  prompt += `## DOCUMENT CONTEXT\n`;
  if (context.description) {
    prompt += `Document summary: ${context.description}\n`;
  }
  prompt += `\n`;

  prompt += `## CHARACTER: ${entityName}\n`;
  prompt += `Entity type: ${context.entityType}\n`;
  prompt += `Primary name: "${entityName}"\n`;

  if (context.aliases && context.aliases.length > 0) {
    prompt += `Known aliases: ${context.aliases.map((a) => `"${a}"`).join(', ')}\n`;
  }

  if (context.description) {
    prompt += `Entity description: ${context.description}\n`;
  }
  prompt += `\n`;

  if (context.states.length > 0) {
    prompt += `## CHARACTER ARC STRUCTURE\n`;
    prompt += `This character has ${context.states.length} distinct states representing their evolution:\n`;

    context.states.forEach((state) => {
      prompt += `  State ${state.phaseIndex + 1}: "${state.name}" (phase ${state.phaseIndex})\n`;
    });
    prompt += `\n`;

    if (context.arcs.length > 0) {
      context.arcs.forEach((arc) => {
        prompt += `Arc: "${arc.name}" (arcType: ${arc.arcType})\n`;
        if (arc.summary) {
          prompt += `Arc summary: ${arc.summary}\n`;
        }
        prompt += `Arc includes states: ${arc.stateIndices.map((i) => i + 1).join(', ')}\n`;

        if (context.arcs.length > 1) {
          const otherArcs = context.arcs.filter((a) => a.id !== arc.id);
          const overlaps = arc.stateIndices.filter((idx) =>
            otherArcs.some((other) => other.stateIndices.includes(idx)),
          );

          if (overlaps.length > 0) {
            prompt += `Note: States ${overlaps.map((i) => i + 1).join(', ')} belong to multiple arcs (character in simultaneous arcs)\n`;
          }
        }
        prompt += `\n`;
      });
    }
  }

  context.states.forEach((state) => {
    prompt += `## STATE ${state.phaseIndex + 1}: "${state.name}"\n`;
    prompt += `Phase index: ${state.phaseIndex}\n`;
    prompt += `Causal order position: ${state.causalOrder}\n`;
    prompt += `Document order range: ${state.documentOrder}`;

    if (state.transitionTo) {
      const nextState = context.states.find(
        (s) => s.id === state.transitionTo!.toStateId,
      );
      if (nextState) {
        prompt += `-${nextState.documentOrder}`;
      }
    }
    prompt += `\n`;

    if (state.segmentIds.length > 0) {
      prompt += `Segments: [segments referenced]\n`;
    }

    if (state.segmentSummary) {
      prompt += `Context: ${state.segmentSummary}\n`;
    }
    prompt += `\n`;

    prompt += `Facets in this state:\n`;
    const facetsByType = new Map<FacetType, typeof state.facets>();
    state.facets.forEach((f) => {
      const existing = facetsByType.get(f.type) || [];
      existing.push(f);
      facetsByType.set(f.type, existing);
    });

    for (const [type, typeFacets] of facetsByType) {
      const facetStrings = typeFacets.map(
        (f) =>
          `"${f.content}" (${f.mentionCount} mentions${f.segmentRange ? `, segments ${f.segmentRange}` : ''})`,
      );
      prompt += `  • ${type} facets: ${facetStrings.join(', ')}\n`;
    }

    if (facetsByType.size === 0) {
      prompt += `  • none\n`;
    }
    prompt += `\n`;

    if (state.events.length > 0) {
      prompt += `Events within this state (causal order):\n`;
      state.events.forEach((event) => {
        prompt += `  • Event at causal:${event.causalOrder} "${event.name}"\n`;
        prompt += `    - Node type: event\n`;
        if (event.description) {
          prompt += `    - Description: ${event.description}\n`;
        }
        if (event.outgoingEdges.length > 0) {
          const edgeStr = event.outgoingEdges
            .map((e) => `${e.type}→"${e.toNodeName}"`)
            .join(', ');
          prompt += `    - Outgoing edges: ${edgeStr}\n`;
        }
      });
      prompt += `\n`;
    }

    if (state.transitionTo) {
      prompt += `State transition:\n`;
      prompt += `  → Transitions to State ${context.states.findIndex((s) => s.id === state.transitionTo!.toStateId) + 1}: "${state.transitionTo.toStateName}"\n`;

      if (
        state.transitionTo.triggerEventId &&
        state.transitionTo.triggerEventName
      ) {
        prompt += `  → Trigger event: "${state.transitionTo.triggerEventName}"\n`;
        if (state.transitionTo.triggerEventDescription) {
          prompt += `  → Event description: ${state.transitionTo.triggerEventDescription}\n`;
        }

        if (state.transitionTo.causationQuality?.level === 'weak') {
          prompt += `  → ⚠️ WEAK CAUSATION: ${state.transitionTo.causationQuality.reason}\n`;
          prompt += `  → Warning: Trigger event description is vague or generic\n`;
        } else if (state.transitionTo.causationQuality?.level === 'none') {
          prompt += `  → ⚠️ NO CAUSATION: Trigger event has no description\n`;
        }

        prompt += `  → Gap detected: false (transition has clear cause)\n`;
      } else if (state.transitionTo.gapDetected) {
        prompt += `  → Trigger event: null\n`;
        prompt += `  → Gap detected: TRUE ⚠️ PLOT HOLE DETECTED\n`;
        prompt += `  → Warning: No triggering event found for this state change. This may indicate: missing event extraction, implicit transition, or genuine plot gap.\n`;
      }
      prompt += `\n`;
    } else {
      prompt += `State transition: none (final state)\n\n`;
    }
  });

  if (context.permanentFacets.length > 0) {
    prompt += `## PERMANENT FACETS (span multiple states)\n`;
    prompt += `These facets are attached to the character entity, not specific states. They remain valid across the entire narrative:\n`;

    context.permanentFacets.forEach((facet) => {
      prompt += `  • ${facet.type}: "${facet.content}" (`;
      if (facet.statesPresent.length > 0) {
        prompt += `mentioned in states ${facet.statesPresent.map((i) => i + 1).join(', ')}`;
      } else {
        prompt += `consistent throughout`;
      }
      prompt += `)\n`;
    });
    prompt += `\n`;
  }

  if (context.causalEdges.length > 0) {
    prompt += `## CAUSAL EDGES FROM CHARACTER\n`;
    prompt += `Edges showing how this character causes or enables other events:\n`;

    context.causalEdges.forEach((edge) => {
      prompt += `  • ${entityName} ${edge.edgeType}→ "${edge.toNodeName}"`;
      if (edge.description) {
        prompt += ` (${edge.description})`;
      }
      prompt += `\n`;
    });
    prompt += `\n`;
  }

  if (context.narrativeEdges.length > 0) {
    prompt += `## NARRATIVE EDGES\n`;
    prompt += `Non-causal relationships:\n`;

    const edgesByType = new Map<StoryEdgeType, typeof context.narrativeEdges>();
    context.narrativeEdges.forEach((e) => {
      const existing = edgesByType.get(e.edgeType) || [];
      existing.push(e);
      edgesByType.set(e.edgeType, existing);
    });

    for (const [type, edges] of edgesByType) {
      const targets = edges.map((e) => `"${e.toNodeName}"`).join(', ');
      prompt += `  • ${type}→ ${targets}\n`;
    }
    prompt += `\n`;
  }

  prompt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  prompt += `## FACETS TO ANALYZE (facet type: ${facetType})\n\n`;
  prompt += `Your task: Analyze the following facets for contradictions.\n\n`;

  facets.forEach((facet, idx) => {
    prompt += `[${idx}] "${facet.content}"\n`;

    const permanent = context.permanentFacets.find((pf) => pf.id === facet.id);
    if (permanent) {
      prompt += `    - Attachment: Permanent (entity-level)\n`;
      prompt += `    - Valid across: All states\n`;
    } else {
      const state = context.states.find((s) =>
        s.facets.some((f) => f.id === facet.id),
      );

      if (state) {
        const stateFacet = state.facets.find((f) => f.id === facet.id)!;
        prompt += `    - State: State ${state.phaseIndex + 1} "${state.name}"\n`;
        prompt += `    - Causal position: ${state.causalOrder}`;

        if (state.transitionTo) {
          const nextState = context.states.find(
            (s) => s.id === state.transitionTo!.toStateId,
          );
          if (nextState) {
            prompt += `-${nextState.causalOrder}`;
          }
        }
        prompt += `\n`;

        if (stateFacet.segmentRange) {
          prompt += `    - Segments: ${stateFacet.segmentRange}\n`;
        }
      }
    }

    prompt += `\n`;
  });

  prompt += `## ANALYSIS INSTRUCTIONS\n\n`;
  prompt += `1. Compare facets WITHIN the same state to find true contradictions\n`;
  prompt += `   - Example: "blue eyes" vs "brown eyes" in State 1 = true_inconsistency\n\n`;
  prompt += `2. Facets in DIFFERENT states connected by trigger events = temporal_change\n`;
  prompt += `   - Example: "inexperienced" (State 1) vs "battle-hardened" (State 2) with trigger event = temporal_change (valid evolution)\n\n`;
  prompt += `3. Permanent facets are valid across ALL states\n`;
  prompt += `   - Do not flag conflicts between permanent facets and state-specific facets\n\n`;
  prompt += `4. Name changes with contextual explanation = intentional aliases\n`;
  prompt += `   - Check event descriptions to see if name change is explained\n\n`;
  prompt += `5. Consider plot holes (gapDetected: true) when evaluating state transitions\n`;
  prompt += `   - If facets differ across states but transition has no trigger event, note this in reasoning\n\n`;
  prompt += `6. Check causal edges to understand WHY changes occur\n`;
  prompt += `   - Events that CAUSE or ENABLE state changes justify facet differences\n\n`;

  prompt += `## OUTPUT FORMAT\n\n`;
  prompt += `Return JSON array of contradictions found. Each entry must have:\n`;
  prompt += `- facetIndexA, facetIndexB (indices from the list above)\n`;
  prompt += `- classificationType: "true_inconsistency" | "temporal_change" | "arc_divergence"\n`;
  prompt += `- reasoning: Explain your classification, referencing state context and events\n\n`;
  prompt += `Return [] if no contradictions found.\n`;

  return prompt;
}

/**
 * Optimize character context to fit within token budget.
 * Applied in order until prompt fits.
 */
function optimizeContextForTokens(context: CharacterContext): CharacterContext {
  const optimized = { ...context };

  optimized.narrativeEdges = optimized.narrativeEdges.map((e) => ({
    ...e,
    description: null,
  }));

  optimized.states = optimized.states.map((state) => ({
    ...state,
    segmentSummary: state.transitionTo?.triggerEventId
      ? state.segmentSummary
      : null,
  }));

  optimized.states = optimized.states.map((state) => ({
    ...state,
    events: state.events.map((event) => ({
      ...event,
      description:
        event.id === state.transitionTo?.triggerEventId
          ? event.description
          : null,
    })),
  }));

  optimized.states = optimized.states.map((state) => ({
    ...state,
    facets: state.facets.map((f) => ({
      ...f,
      segmentRange: '',
    })),
  }));

  return optimized;
}

/**
 * Persist detected conflicts to review_queue table.
 */
async function persistConflicts(
  conflicts: DetectedConflict[],
  documentId: string,
  contextMap: Map<string, CharacterContext>,
): Promise<void> {
  if (conflicts.length === 0) return;

  const insertPromises = conflicts.map(async (conflict) => {
    const entityContext = contextMap.get(conflict.entityId);

    const stateIds =
      entityContext?.states
        .filter((s) =>
          s.facets.some(
            (f) => f.id === conflict.facetA.id || f.id === conflict.facetB.id,
          ),
        )
        .map((s) => s.id) || [];

    const reasoning = conflict.reasoning.toLowerCase();
    const isPlotHole =
      reasoning.includes('gapdetected') ||
      reasoning.includes('plot hole') ||
      reasoning.includes('missing trigger');
    const isWeakCausation =
      reasoning.includes('weak') ||
      reasoning.includes('vague causation') ||
      reasoning.includes('generic');

    const relevantState = entityContext?.states.find((s) =>
      s.facets.some(
        (f) => f.id === conflict.facetA.id || f.id === conflict.facetB.id,
      ),
    );
    const causationQuality = relevantState?.transitionTo?.causationQuality;

    const segments = await segmentService.getDocumentSegments(documentId);
    const facetAMentions =
      await mentionService.getByNodeIdWithAbsolutePositions(
        conflict.facetA.id,
        segments,
      );
    const facetBMentions =
      await mentionService.getByNodeIdWithAbsolutePositions(
        conflict.facetB.id,
        segments,
      );

    const sourcePositions = {
      facetA: facetAMentions.slice(0, 3).map((m) => ({
        segmentId: m.segmentId,
        start: m.absoluteStart,
        end: m.absoluteEnd,
      })),
      facetB: facetBMentions.slice(0, 3).map((m) => ({
        segmentId: m.segmentId,
        start: m.absoluteStart,
        end: m.absoluteEnd,
      })),
    };

    return db.insert(reviewQueue).values({
      documentId,
      itemType: 'contradiction',
      primaryEntityId: conflict.entityId,
      facetIds: [conflict.facetA.id, conflict.facetB.id],
      stateIds: stateIds.length > 0 ? stateIds : null,
      contextSummary: conflict.reasoning,
      conflictType: conflict.conflictType,
      sourcePositions,
      resolution: {
        metadata: {
          isPlotHole,
          isWeakCausation,
          facetType: conflict.facetType,
          entityName: conflict.entityName,
          causationQuality,
        },
        facets: {
          facetA: conflict.facetA,
          facetB: conflict.facetB,
        },
      },
    });
  });

  await Promise.all(insertPromises);

  logger.info(
    {
      documentId,
      conflictCount: conflicts.length,
      plotHoleCount: conflicts.filter(
        (c) =>
          c.reasoning.toLowerCase().includes('gapdetected') ||
          c.reasoning.toLowerCase().includes('plot hole'),
      ).length,
    },
    'Stage 9: Conflicts persisted to review queue',
  );
}

/**
 * Detect contradictions with full character context.
 */
async function detectContradictionsWithContext(
  entityName: string,
  facetType: FacetType,
  facets: StoredFacet[],
  context: CharacterContext,
  userId: string,
  documentId: string,
): Promise<
  Array<{
    facetIndexA: number;
    facetIndexB: number;
    classificationType:
      | 'true_inconsistency'
      | 'temporal_change'
      | 'arc_divergence';
    reasoning: string;
  }>
> {
  let prompt = buildContextPrompt(entityName, facetType, facets, context);

  const modelConfig = getTextModelConfig('gemini-2.0-flash-lite');
  const charsPerToken = modelConfig.charsPerToken ?? 3.3;
  let promptTokens = countTokens(prompt, charsPerToken);
  const maxInputTokens = modelConfig.maxTokens || 1_000_000;
  const threshold = maxInputTokens * 0.9;

  if (promptTokens > threshold) {
    logger.warn(
      {
        entityId: context.entityId,
        promptTokens,
        maxInputTokens,
        threshold,
      },
      'Context approaching token limit - applying optimization',
    );

    const optimizedContext = optimizeContextForTokens(context);
    prompt = buildContextPrompt(
      entityName,
      facetType,
      facets,
      optimizedContext,
    );
    promptTokens = countTokens(prompt, charsPerToken);

    if (promptTokens > threshold) {
      logger.error(
        {
          entityId: context.entityId,
          promptTokens,
          maxInputTokens,
        },
        'Cannot fit entity context within token limits - falling back to legacy',
      );

      return detectContradictionsInBatch(
        entityName,
        facetType,
        facets.map((f) => ({ content: f.content })),
        userId,
        documentId,
      );
    }
  }

  logger.info(
    {
      stage: 10,
      operation: 'detectContradictions',
      entityId: context.entityId,
      promptTokens,
      estimatedResponseTokens: facets.length * 50,
    },
    'Context-aware conflict detection prompt generated',
  );

  const result = await detectContradictionsInBatch(
    entityName,
    facetType,
    facets.map((f) => ({ content: f.content })),
    userId,
    documentId,
    prompt,
  );

  return result;
}

/**
 * Stage 8: Detect facet conflicts.
 *
 * For each entity, compare same-type facets for contradictions.
 * Uses embedding similarity to identify potential conflicts.
 * Classifies conflicts using the taxonomy.
 *
 * Results are logged for future user review UI.
 */
async function detectFacetConflicts(
  documentId: string,
  userId: string,
): Promise<void> {
  const allNodes = await graphStoryNodesRepository.getActiveNodes(
    documentId,
    userId,
  );

  const segments = await segmentService.getDocumentSegments(documentId);

  const causalOrderResults = await computeCausalOrder(documentId, userId);
  const causalOrderMap = new Map(
    causalOrderResults.map((r) => [r.nodeId, r.position]),
  );

  // Process entities in parallel
  const entityResults = await Promise.all(
    allNodes.map(async (entity) => {
      const context = await buildCharacterContext(
        entity,
        segments,
        causalOrderMap,
        documentId,
        userId,
      );

      const entityConflicts: DetectedConflict[] = [];
      const facetsByType = groupFacetsByType(context.allFacets);

      for (const [facetType, typeFacets] of facetsByType) {
        if (typeFacets.length < 2) continue;

        try {
          const contradictions = await detectContradictionsWithContext(
            entity.name,
            facetType,
            typeFacets,
            context,
            userId,
            documentId,
          );

          // Map LLM results back to facet IDs and add to conflicts list
          for (const contradiction of contradictions) {
            const facetA = typeFacets[contradiction.facetIndexA];
            const facetB = typeFacets[contradiction.facetIndexB];

            if (!facetA || !facetB) {
              logger.warn(
                {
                  entityId: entity.id,
                  facetIndexA: contradiction.facetIndexA,
                  facetIndexB: contradiction.facetIndexB,
                  totalFacets: typeFacets.length,
                },
                'LLM returned invalid facet indices',
              );
              continue;
            }

            entityConflicts.push({
              entityId: entity.id,
              entityName: entity.name,
              facetType,
              facetA: { id: facetA.id, content: facetA.content },
              facetB: { id: facetB.id, content: facetB.content },
              conflictType: contradiction.classificationType,
              reasoning: contradiction.reasoning,
            });
          }
        } catch (error) {
          logger.error(
            {
              entityId: entity.id,
              entityName: entity.name,
              facetType,
              facetCount: typeFacets.length,
              error: (error as Error).message,
            },
            'Failed to detect contradictions for entity facets',
          );
        }
      }

      return { context, conflicts: entityConflicts };
    }),
  );

  // Flatten results
  const conflicts: DetectedConflict[] = [];
  const contextMap = new Map<string, CharacterContext>();

  for (const result of entityResults) {
    contextMap.set(result.context.entityId, result.context);
    conflicts.push(...result.conflicts);
  }

  // Persist all conflicts to review queue
  await persistConflicts(conflicts, documentId, contextMap);

  // Log conflicts and queue true_inconsistency for user review
  if (conflicts.length > 0) {
    const trueInconsistencies = conflicts.filter(
      (c) => c.conflictType === 'true_inconsistency',
    );

    const plotHoles = conflicts.filter(
      (c) =>
        c.reasoning.toLowerCase().includes('gapdetected') ||
        c.reasoning.toLowerCase().includes('plot hole'),
    );

    const weakCausation = conflicts.filter(
      (c) =>
        c.reasoning.toLowerCase().includes('weak') ||
        c.reasoning.toLowerCase().includes('vague causation'),
    );

    for (const conflict of conflicts) {
      logger.info(
        {
          stage: 10,
          type: 'conflict_detected',
          documentId,
          entityId: conflict.entityId,
          entityName: conflict.entityName,
          facetType: conflict.facetType,
          facetA: conflict.facetA,
          facetB: conflict.facetB,
          conflictType: conflict.conflictType,
          reasoning: conflict.reasoning,
          requiresReview: conflict.conflictType === 'true_inconsistency',
        },
        `Conflict detected: ${conflict.entityName} (${conflict.facetType})`,
      );
    }

    if (plotHoles.length > 0) {
      logger.warn(
        {
          stage: 10,
          documentId,
          plotHoles: plotHoles.map((c) => ({
            entity: c.entityName,
            reasoning: c.reasoning,
          })),
        },
        'Plot holes detected - UI not yet implemented for user review',
      );
    }

    if (weakCausation.length > 0) {
      logger.warn(
        {
          stage: 10,
          documentId,
          weakCausation: weakCausation.map((c) => ({
            entity: c.entityName,
            reasoning: c.reasoning,
          })),
        },
        'Weak causation detected - UI not yet implemented for user review',
      );
    }

    // TODO: Review queue disabled until UI is built.
    // Conflict detection now uses LLM batch analysis (accurate, conservative).
    // Re-enable queue when UI ready:
    //
    // for (const conflict of trueInconsistencies) {
    //   await reviewQueueService.add({ ... });
    // }

    logger.info(
      {
        documentId,
        totalConflicts: conflicts.length,
        trueInconsistencies: trueInconsistencies.length,
        temporalChanges: conflicts.filter(
          (c) => c.conflictType === 'temporal_change',
        ).length,
        arcDivergences: conflicts.filter(
          (c) => c.conflictType === 'arc_divergence',
        ).length,
        plotHoles: plotHoles.length,
        weakCausation: weakCausation.length,
      },
      'Conflict detection summary',
    );

    // TODO: Store for user review UI
    // TODO: Implement UI for plot hole review/confirmation
    // TODO: Implement UI for weak causation suggestions
  } else {
    logger.info({ documentId }, 'No facet conflicts detected');
  }
}

/**
 * Calculate cosine similarity between two embedding vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Generate descriptions for all entities using descriptionService.
 * Batches entities for efficient LLM processing.
 */
async function generateEntityDescriptions(
  documentId: string,
  userId: string,
  _entityIdByName: Map<string, string>,
): Promise<void> {
  const allNodes = await graphStoryNodesRepository.getActiveNodes(
    documentId,
    userId,
  );

  if (allNodes.length === 0) {
    logger.info({ documentId }, 'No entities to generate descriptions for');
    return;
  }

  logger.info(
    { documentId, entityCount: allNodes.length },
    'Generating entity descriptions',
  );

  const client = await getGeminiClient();
  if (!client) {
    logger.warn(
      { documentId },
      'Gemini client unavailable, skipping descriptions',
    );
    return;
  }

  const llmGenerate = async (prompt: string): Promise<string> => {
    const modelConfig = getTextModelConfig('gemini-2.5-flash-lite');
    const maxOutputTokens = modelConfig.maxOutputTokens;
    if (!maxOutputTokens) {
      throw new Error(`Model missing maxOutputTokens configuration`);
    }

    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: prompt,
      config: {
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return result.text ?? '';
  };

  // Build entity input for descriptionService
  const entities = await Promise.all(
    allNodes.map(async (node) => {
      const facets = await graphService.getFacetsForEntity(node.id);
      const states = await graphService.getCharacterStates(node.id);
      const currentState = states.length > 0 ? states[states.length - 1] : null;

      return {
        id: node.id,
        name: node.name,
        type: node.type,
        permanentFacets: facets.filter((f) => f.type !== 'state'),
        stateFacets: facets.filter((f) => f.type === 'state'),
        currentState,
        currentDescription: node.description || undefined,
      };
    }),
  );

  try {
    const results = await descriptionService.generateBatch(
      { entities },
      llmGenerate,
    );

    // Update entities with new descriptions
    for (const result of results) {
      if (result.method !== 'no_change' && result.description) {
        await graphService.updateStoryNode(result.entityId, {
          description: result.description,
        });
      }
    }

    logger.info(
      {
        documentId,
        generated: results.filter((r) => r.method === 'initial').length,
        regenerated: results.filter((r) => r.method === 'regenerate').length,
        edited: results.filter((r) => r.method === 'edit').length,
        noChange: results.filter((r) => r.method === 'no_change').length,
      },
      'Entity descriptions generated',
    );
  } catch (error) {
    logger.error(
      { documentId, error },
      'Failed to generate entity descriptions',
    );
    throw error;
  }
}

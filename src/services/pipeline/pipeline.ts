/**
 * Multi-stage extraction pipeline.
 *
 * Stage 1: Segmentation + Sentence Embeddings (algorithmic)
 * Stage 2: Entity + Facet Extraction (LLM, parallel per segment)
 * Stage 3: Text Grounding (algorithmic + embeddings)
 * Stage 4: Entity Resolution (multi-signal batch clustering)
 * Stage 5: Intra-Segment Relationships (LLM, parallel per segment)
 * Stage 6: Cross-Segment Relationships (LLM, sequential)
 * Stage 7: Higher-Order Analysis (LLM + algorithmic)
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents } from '../../models/schema';
import type { FacetInput, FacetType, StoryEdgeType, StoryNodeType } from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import { generateEmbedding, generateEmbeddings } from '../embeddings';
import {
  extractEntitiesFromSegment,
  extractRelationshipsFromSegment,
  extractCrossSegmentRelationships,
  analyzeHigherOrder,
  type Stage4RelationshipsResult,
  type Stage5HigherOrderResult,
} from '../gemini/client';
import {
  resolveEntities,
  mapToLegacyDecision,
  needsLLMRefinement,
  type EntityCandidate,
  type ExistingEntity,
} from '../entityResolution';
import { graphService } from '../graph/graph.service';
import { mentionService } from '../mentions';
import { type Segment, segmentService } from '../segments';
import { sentenceService } from '../sentences';
import {
  graphStoryNodesRepository,
  selectEntitiesForContext,
  recomputeEntityEmbeddingWithMentionWeights,
} from '../storyNodes';
import { sseService } from '../sse';
import { type AnalysisStage, getStageLabel } from './stages';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  shouldRunStage,
  isCheckpointValid,
} from './checkpoint';
import { AnalysisCancelledError, AnalysisPausedError } from './errors';

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

  if (doc?.analysisStatus === 'cancelling') {
    await clearCheckpoint(documentId);
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

    const broadcast = (stage: AnalysisStage, entityCount?: number, statusHint?: string) => {
      if (!broadcastProgress) return;
      sseService.broadcastToDocument(documentId, 'analysis-progress', {
        documentId,
        stage,
        statusHint: statusHint || getStageLabel(stage),
        entityCount,
        timestamp: new Date().toISOString(),
      });
    };

    // Load checkpoint and check version
    let checkpoint = await loadCheckpoint(documentId);
    if (checkpoint && !isCheckpointValid(checkpoint, versionNumber)) {
      logger.info(
        { documentId, checkpointVersion: checkpoint.documentVersion, currentVersion: versionNumber },
        'Document version changed, invalidating checkpoint'
      );
      await clearCheckpoint(documentId);
      checkpoint = null;
    }

    if (checkpoint) {
      logger.info(
        { documentId, lastStageCompleted: checkpoint.lastStageCompleted },
        'Resuming from checkpoint'
      );
    }

    // Stage 1: Segmentation + Sentence Embeddings
    if (shouldRunStage(checkpoint, 1)) {
      await checkForInterruption(documentId);
      broadcast(1);
      logger.info({ documentId, segmentCount: segments.length }, 'Stage 1: Processing segments');

      await sentenceService.processDocument(documentId, documentContent, segments);

      await saveCheckpoint(documentId, {
        documentVersion: versionNumber,
        lastStageCompleted: 1,
      });
    } else {
      logger.info({ documentId }, 'Skipping Stage 1 (already completed)');
    }

    // Stage 2: Entity + Facet Extraction (parallel per segment)
    let extractedEntities: ExtractedEntity[];

    if (shouldRunStage(checkpoint, 2)) {
      await checkForInterruption(documentId);
      broadcast(2);
      logger.info({ documentId }, 'Stage 2: Extracting entities from segments');

      extractedEntities = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentText = documentContent.slice(segment.start, segment.end);

        // Get context for this segment
        let existingContext: Array<{
          id: string;
          name: string;
          type: string;
          facets: Array<{ type: string; content: string }>;
          mentionCount: number;
        }> = [];

        if (!isInitialExtraction || i > 0) {
          // For incremental or later segments, get context
          const adjacentIds = segmentService.getAdjacentSegments(segments, [segment.id], 1);

          // Get average embedding for this segment's sentences
          const sentenceEmbeddings = await sentenceService.getBySegmentIds(documentId, [segment.id]);
          if (sentenceEmbeddings.length > 0) {
            const avgEmbedding = sentenceService.computeAverageEmbedding(
              sentenceEmbeddings.map((s) => s.embedding)
            );
            existingContext = await selectEntitiesForContext(
              documentId,
              userId,
              avgEmbedding,
              adjacentIds
            );
          }
        }

        // Extract from this segment
        const result = await extractEntitiesFromSegment(
          segmentText,
          i,
          segments.length,
          existingContext
        );

        // Transform flat results to extracted entities
        for (const entity of result.entities) {
          const entityFacets = result.facets
            .filter((f) => f.entityName === entity.name)
            .map((f) => ({ type: f.facetType as FacetType, content: f.content }));

          const entityMentions = result.mentions
            .filter((m) => m.entityName === entity.name)
            .map((m) => ({ text: m.text }));

          extractedEntities.push({
            segmentId: segment.id,
            name: entity.name,
            type: entity.type as StoryNodeType,
            documentOrder: entity.documentOrder,
            facets: entityFacets,
            mentions: entityMentions,
          });
        }

        broadcast(2, extractedEntities.length, `Processing segment ${i + 1} of ${segments.length}...`);
      }

      logger.info(
        { documentId, extractedCount: extractedEntities.length },
        'Stage 2 complete: Entities extracted'
      );

      await saveCheckpoint(documentId, {
        lastStageCompleted: 2,
        stage2Output: { extractedEntities },
      });
    } else if (checkpoint?.stage2Output) {
      extractedEntities = checkpoint.stage2Output.extractedEntities;
      logger.info(
        { documentId, cachedCount: extractedEntities.length },
        'Skipping Stage 2 (using cached entities)'
      );
    } else {
      throw new Error('Checkpoint inconsistency: Stage 2 skipped but no cached data');
    }

    // Stage 3: Text Grounding (algorithmic)
    if (shouldRunStage(checkpoint, 3)) {
      await checkForInterruption(documentId);
      broadcast(3, extractedEntities.length);
      logger.info({ documentId }, 'Stage 3: Grounding entities to text');

      // Text grounding is done inline during entity resolution
      // This stage primarily validates and prepares grounding data

      await saveCheckpoint(documentId, { lastStageCompleted: 3 });
    } else {
      logger.info({ documentId }, 'Skipping Stage 3 (already completed)');
    }

    // Stage 4: Entity Resolution (batch clustering)
    let resolvedEntities: ResolvedEntity[];
    let entityIdByName: Map<string, string>;

    if (shouldRunStage(checkpoint, 4)) {
      await checkForInterruption(documentId);
      broadcast(4, extractedEntities.length);
      logger.info({ documentId }, 'Stage 4: Resolving entities with multi-signal clustering');

      resolvedEntities = [];
      entityIdByName = new Map<string, string>();

      // Get existing entities for resolution
      const existingNodes = await graphStoryNodesRepository.getActiveNodes(documentId, userId);

      // Generate embeddings for all entities in a single batch call
      const entityTexts = extractedEntities.map(
        (entity) => `${entity.name}: ${entity.facets.map((f) => f.content).join(', ')}`
      );
      const entityEmbeddings = await generateEmbeddings(entityTexts);

      // Convert extracted entities to EntityCandidate format
      const entityCandidates: EntityCandidate[] = extractedEntities.map((entity, i) => ({
        name: entity.name,
        type: entity.type,
        embedding: entityEmbeddings[i],
        facets: entity.facets,
        mentions: entity.mentions.map((m) => ({ text: m.text, segmentId: entity.segmentId })),
        segmentId: entity.segmentId,
        documentOrder: entity.documentOrder,
      }));

      // Build existing entities with embeddings and facets
      const existingEntities: ExistingEntity[] = [];
      for (const node of existingNodes) {
        const facets = await graphService.getFacetsForEntity(node.id);
        const mentionCount = await mentionService.getMentionCount(node.id);
        const embedding = await graphService.getNodeEmbedding(node.id);

        existingEntities.push({
          id: node.id,
          name: node.name,
          type: node.type,
          embedding: embedding || undefined,
          aliases: node.aliases || undefined,
          facets: facets.map((f) => ({ type: f.type, content: f.content })),
          mentionCount,
        });
      }

      // Run batch entity resolution
      const resolutionResults = await resolveEntities(
        entityCandidates,
        existingEntities,
        { documentId, userId }
      );

      logger.info(
        {
          documentId,
          clusters: resolutionResults.stats.totalClusters,
          autoMerged: resolutionResults.stats.autoMerged,
          needsReview: resolutionResults.stats.needsReview,
          created: resolutionResults.stats.created,
        },
        'Stage 4: Batch clustering complete'
      );

      // Process resolution results
      for (const result of resolutionResults.results) {
        const { cluster, decision, targetId, newFacets } = result;
        const legacyDecision = mapToLegacyDecision(result);

        // Determine entity ID
        let entityId: string;
        if (decision === 'MERGE' && targetId) {
          entityId = targetId;
        } else {
          entityId = randomUUID();
        }

        // Map cluster primary name to entity ID
        entityIdByName.set(cluster.primaryName, entityId);

        // Also map all aliases to the same entity ID
        for (const alias of cluster.aliases) {
          if (alias !== cluster.primaryName) {
            entityIdByName.set(alias, entityId);
          }
        }

        // Track resolved entities for later stages
        for (const member of cluster.members) {
          resolvedEntities.push({
            segmentId: member.segmentId,
            name: member.name,
            type: member.type,
            documentOrder: member.documentOrder,
            facets: newFacets || member.facets,
            mentions: member.mentions.map((m) => ({ text: m.text })),
            id: entityId,
            decision: legacyDecision,
            targetEntityId: targetId,
          });
        }

        // Handle REVIEW decisions that need LLM refinement
        if (needsLLMRefinement(result)) {
          logger.debug(
            {
              clusterName: cluster.primaryName,
              score: result.score,
              confidence: result.confidence,
            },
            'Stage 4: Cluster needs LLM refinement (skipping for now)'
          );
        }
      }

      // Create entities and facets in the database
      // Iterate over unique entity IDs, not name→id mappings (which include aliases)
      const uniqueEntityIds = new Set(entityIdByName.values());

      logger.info(
        { documentId, resolvedCount: resolvedEntities.length, uniqueEntities: uniqueEntityIds.size },
        'Stage 4 complete: Entities resolved'
      );
      broadcast(4, uniqueEntityIds.size, 'Creating entities...');

      const createdEntityIds = new Set<string>();

      for (const entityId of uniqueEntityIds) {
        // Find ALL resolved entities that map to this entityId (includes aliases)
        const entityInstances = resolvedEntities.filter(
          (e) => entityIdByName.get(e.name) === entityId
        );
        if (entityInstances.length === 0) continue;

        const firstInstance = entityInstances[0];

        // Pick the primary name (first instance, or could enhance to pick most common)
        const primaryName = firstInstance.name;

        if (firstInstance.decision === 'NEW') {
          // Merge all facets from ALL instances (across different name variations)
          const allFacets: FacetInput[] = [];
          for (const instance of entityInstances) {
            allFacets.push(...instance.facets);
          }
          const uniqueFacets = Array.from(
            new Map(allFacets.map((f) => [`${f.type}:${f.content}`, f])).values()
          );

          // Create entity (idempotent by ID)
          const { created } = await graphService.createStoryNodeIdempotent(
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
            }
          );

          if (created) {
            // Create facets only for newly created entities
            for (const facet of uniqueFacets) {
              const facetEmbedding = await generateEmbedding(facet.content);
              await graphService.createFacet(entityId, facet, facetEmbedding);
            }
            createdEntityIds.add(entityId);
          }
        } else if (firstInstance.decision === 'ADD_FACET') {
          // Add new facets to existing entity
          const allNewFacets: FacetInput[] = [];
          for (const instance of entityInstances) {
            if (instance.facets) allNewFacets.push(...instance.facets);
          }

          for (const facet of allNewFacets) {
            const facetEmbedding = await generateEmbedding(facet.content);
            await graphService.createFacet(entityId, facet, facetEmbedding);
          }
        }

        // Create mentions for all instances (covers all name variations)
        for (const instance of entityInstances) {
          const segment = segments.find((s) => s.id === instance.segmentId);
          if (!segment) continue;

          const segmentText = documentContent.slice(segment.start, segment.end);

          for (const mention of instance.mentions) {
            const relativeIndex = segmentText.indexOf(mention.text);
            if (relativeIndex !== -1) {
              const absoluteStart = segment.start + relativeIndex;
              await mentionService.createFromAbsolutePosition(
                entityId,
                documentId,
                absoluteStart,
                absoluteStart + mention.text.length,
                mention.text,
                versionNumber,
                segments,
                'extraction',
                100
              );
            }
          }
        }

        // Recompute entity embedding with mention weights
        if (createdEntityIds.has(entityId) || firstInstance.decision === 'ADD_FACET') {
          await recomputeEntityEmbeddingWithMentionWeights(entityId);
        }
      }

      await saveCheckpoint(documentId, {
        lastStageCompleted: 4,
        stage4Output: { entityIdByName: Object.fromEntries(entityIdByName) },
      });
    } else if (checkpoint?.stage4Output) {
      // Reconstruct from checkpoint
      entityIdByName = new Map(Object.entries(checkpoint.stage4Output.entityIdByName));

      // Reconstruct resolvedEntities from extractedEntities + entityIdByName
      resolvedEntities = extractedEntities
        .map((e) => ({
          ...e,
          id: entityIdByName.get(e.name) || '',
          decision: 'NEW' as const,
        }))
        .filter((e) => e.id);

      logger.info(
        { documentId, cachedEntities: entityIdByName.size },
        'Skipping Stage 4 (using cached entity mapping)'
      );
    } else {
      throw new Error('Checkpoint inconsistency: Stage 4 skipped but no cached data');
    }

    // Stage 5: Intra-Segment Relationship Extraction (parallel per segment)
    const allRelationships: Stage4RelationshipsResult['relationships'] = [];

    if (shouldRunStage(checkpoint, 5)) {
      await checkForInterruption(documentId);
      broadcast(5, entityIdByName.size);
      logger.info({ documentId }, 'Stage 5: Extracting intra-segment relationships');

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentText = documentContent.slice(segment.start, segment.end);

        broadcast(5, entityIdByName.size, `Extracting relationships: segment ${i + 1}/${segments.length}`);

        // Get resolved entities in this segment
        const entitiesInSegment = resolvedEntities.filter((e) => e.segmentId === segment.id);
        const uniqueEntitiesInSegment = Array.from(
          new Map(entitiesInSegment.map((e) => [e.id, e])).values()
        );

        if (uniqueEntitiesInSegment.length < 2) continue;

        const result = await extractRelationshipsFromSegment(
          segmentText,
          i,
          uniqueEntitiesInSegment.map((e) => ({
            id: e.id,
            name: e.name,
            type: e.type,
            keyFacets: e.facets.slice(0, 3).map((f) => f.content),
          }))
        );

        allRelationships.push(...result.relationships);
      }

      logger.info(
        { documentId, relationshipCount: allRelationships.length },
        'Stage 5 complete: Intra-segment relationships extracted'
      );

      await saveCheckpoint(documentId, { lastStageCompleted: 5 });
    } else {
      logger.info({ documentId }, 'Skipping Stage 5 (already completed)');
    }

    // Stage 6: Cross-Segment Relationships
    if (shouldRunStage(checkpoint, 6)) {
      await checkForInterruption(documentId);
      broadcast(6, entityIdByName.size);
      logger.info({ documentId }, 'Stage 6: Extracting cross-segment relationships');

      // Build entity list with segment associations
      const entityWithSegments: EntityWithSegments[] = [];
      for (const [name, id] of entityIdByName) {
        const instances = resolvedEntities.filter((e) => e.name === name);
        const segmentIds = [...new Set(instances.map((e) => e.segmentId))];
        const keyFacets = instances[0]?.facets.slice(0, 3).map((f) => f.content) || [];

        entityWithSegments.push({
          id,
          name,
          type: instances[0]?.type || 'other',
          segmentIds,
          keyFacets,
        });
      }

      // Only run cross-segment if we have entities in multiple segments
      const entitiesInMultipleSegments = entityWithSegments.filter((e) => e.segmentIds.length > 1);

      if (entitiesInMultipleSegments.length > 0) {
        broadcast(6, entityIdByName.size, 'Finding cross-segment connections...');
        const crossSegmentResult = await extractCrossSegmentRelationships(
          documentTitle ? `Document: "${documentTitle}"` : undefined,
          entityWithSegments,
          allRelationships.map((r) => ({
            fromId: r.fromId,
            toId: r.toId,
            edgeType: r.edgeType,
          }))
        );

        allRelationships.push(...crossSegmentResult.relationships);
      }

      logger.info(
        { documentId, totalRelationships: allRelationships.length },
        'Stage 6 complete: Cross-segment relationships extracted'
      );

      // Create relationships in database (idempotent)
      for (const rel of allRelationships) {
        try {
          await graphService.createStoryConnectionIdempotent(
            rel.fromId,
            rel.toId,
            rel.edgeType as StoryEdgeType,
            rel.description,
            { strength: rel.strength }
          );
        } catch (err: any) {
          if (!err?.message?.includes('would create a cycle')) {
            logger.warn({ rel, error: err }, 'Failed to create relationship');
          }
        }
      }

      await saveCheckpoint(documentId, { lastStageCompleted: 6 });
    } else {
      logger.info({ documentId }, 'Skipping Stage 6 (already completed)');
    }

    // Stage 7: Higher-Order Analysis
    let higherOrderResult: Stage5HigherOrderResult | null = null;

    if (shouldRunStage(checkpoint, 7)) {
      await checkForInterruption(documentId);
      broadcast(7, entityIdByName.size);
      logger.info({ documentId }, 'Stage 7: Analyzing higher-order structure');

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
            .filter((c) => ['CAUSES', 'ENABLES', 'PREVENTS'].includes(c.edgeType))
            .map((c) => ({
              type: c.edgeType as 'CAUSES' | 'ENABLES' | 'PREVENTS',
              targetId: c.toNodeId,
              strength: c.strength || 0.5,
            }));

          // Get connected characters
          const participates = connections.filter((c) => c.edgeType === 'PARTICIPATES_IN');
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
          const stateFacetsBySegment: Array<{ segmentIndex: number; states: string[] }> = [];

          for (const instance of instances) {
            const segmentIndex = segments.findIndex((s) => s.id === instance.segmentId);
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
          documentTitle
        );

        // Create narrative threads (idempotent)
        for (const thread of higherOrderResult.narrativeThreads) {
          const { id: threadId, created } = await graphService.createNarrativeThreadIdempotent(
            documentId,
            userId,
            {
              name: thread.name,
              isPrimary: thread.isPrimary,
              eventNames: [],
            }
          );

          if (created) {
            for (const [i, eventId] of thread.eventIds.entries()) {
              await graphService.linkEventToThread(eventId, threadId, i);
            }
          }
        }

        // Process character arcs from flattened arcPhases
        if (higherOrderResult.arcPhases && higherOrderResult.arcPhases.length > 0) {
          await processCharacterArcs(
            higherOrderResult.arcPhases,
            documentId,
            userId,
            entityIdByName,
            events
          );
        }
      }

      logger.info(
        {
          documentId,
          threadCount: higherOrderResult?.narrativeThreads.length || 0,
          arcCount: new Set((higherOrderResult?.arcPhases || []).map((p) => p.characterId)).size,
          arcPhaseCount: higherOrderResult?.arcPhases?.length || 0,
        },
        'Stage 7 complete: Higher-order analysis done'
      );

      // Clear checkpoint on successful completion
      await clearCheckpoint(documentId);
    } else {
      logger.info({ documentId }, 'Skipping Stage 7 (already completed)');
      await clearCheckpoint(documentId);
    }

    // Count unique characters with arcs
    const uniqueCharactersWithArcs = new Set(
      (higherOrderResult?.arcPhases || []).map((p) => p.characterId)
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
  _characters: Array<{ id: string; participatesInEventIds: string[] }>
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
  events: Array<{ id: string; documentOrder: number }>
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
    const arcId = await graphService.createArc(characterId, documentId, userId, {
      arcType,
    });

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
      const stateId = await graphService.createCharacterState(
        characterId,
        documentId,
        userId,
        {
          name: phase.phaseName,
          phaseIndex: phase.phaseIndex,
          documentOrder,
          causalOrder,
        }
      );

      stateIds.push(stateId);

      // Link state to arc
      await graphService.linkStateToArc(stateId, arcId, phase.phaseIndex);

      // Link character to state (mark last one as current)
      const isCurrent = phase.phaseIndex === phases.length - 1;
      await graphService.linkCharacterToState(characterId, stateId, isCurrent);

      // Link state to facets mentioned in stateFacets
      // Find matching facets from the entity's existing facets
      const entityFacets = await graphService.getFacetsForEntity(characterId);
      for (const facetContent of phase.stateFacets) {
        const matchingFacet = entityFacets.find(
          (f) => f.content.toLowerCase().includes(facetContent.toLowerCase()) ||
                 facetContent.toLowerCase().includes(f.content.toLowerCase())
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
          const sumEmbedding = embeddings[0].map((_, i) =>
            embeddings.reduce((sum, e) => sum + e[i], 0) / embeddings.length
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

      await graphService.createChangesToEdge(fromStateId, toStateId, {
        triggerEventId: toPhase.triggerEventId,
        gapDetected: toPhase.triggerEventId === null && i > 0,
      });
    }

    logger.info(
      { characterId, arcId, stateCount: stateIds.length, arcType },
      'Character arc processed'
    );
  }
}

/**
 * FalkorDB Graph-backed repository for story node and connection persistence.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConnectionUpdate,
  EntityResolutionResult,
  EventRange,
  FacetInput,
  NarrativeThreadResult,
  NodeUpdate,
  ResolvedEntity,
  StoryConnectionResult,
  StoryNodeFacetResult,
  StoryNodeMention,
  StoryNodeResult,
  TextPosition,
} from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import { buildEmbeddingText, generateEmbedding } from '../embeddings';
import { graphService, type StoredStoryNode } from '../graph/graph.service';
import { fuzzyFindText, mentionService } from '../mentions';
import { type Segment, segmentService } from '../segments';

interface CreateNodesParams {
  userId: string;
  documentId: string;
  nodes: StoryNodeResult[];
  connections: StoryConnectionResult[];
  narrativeThreads?: NarrativeThreadResult[];
  documentContent: string;
  segments: Segment[];
  versionNumber: number;
  documentStyle?: { preset: string | null; prompt: string | null };
}

interface CreateNodesWithFacetsParams {
  userId: string;
  documentId: string;
  nodes: StoryNodeFacetResult[];
  connections: StoryConnectionResult[];
  narrativeThreads?: NarrativeThreadResult[];
  documentContent: string;
  segments: Segment[];
  versionNumber: number;
  documentStyle?: { preset: string | null; prompt: string | null };
}

interface CreateConnectionsParams {
  connections: StoryConnectionResult[];
  nodeNameToId: Map<string, string>;
}

interface ApplyUpdatesParams {
  userId: string;
  documentId: string;
  documentContent: string;
  segments: Segment[];
  versionNumber: number;
  existingNodes: Array<{ id: string; name: string }>;
  updates: {
    add: StoryNodeResult[];
    update: NodeUpdate[];
    delete: string[];
    connectionUpdates: {
      add: ConnectionUpdate[];
      delete: { fromId: string; toId: string }[];
    };
    narrativeThreads?: NarrativeThreadResult[];
  };
  documentStyle?: { preset: string | null; prompt: string | null };
}

/** Model configuration for context budget calculation */
interface ModelConfig {
  contextWindow: number;
  targetUsage: number;
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  contextWindow: 128000,
  targetUsage: 0.5,
};

/**
 * Estimate token count for text (rough approximation: 4 chars = 1 token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format an entity for context inclusion.
 */
function formatEntityForContext(entity: {
  id: string;
  name: string;
  type: string;
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
}): string {
  const facetsByType: Record<string, string[]> = {};
  for (const f of entity.facets) {
    if (!facetsByType[f.type]) facetsByType[f.type] = [];
    facetsByType[f.type].push(f.content);
  }

  return `[${entity.id}] ${entity.type.toUpperCase()}: "${entity.name}" (${entity.mentionCount} mentions)
  Names: ${facetsByType['name']?.join(', ') || 'none'}
  Appearance: ${facetsByType['appearance']?.join(', ') || 'none'}`;
}

/**
 * Select entities for Stage 1 context based on embedding similarity and budget.
 */
export async function selectEntitiesForContext(
  documentId: string,
  userId: string,
  segmentEmbedding: number[],
  adjacentSegmentIds: string[],
  modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG
): Promise<Array<{
  id: string;
  name: string;
  type: string;
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
}>> {
  // Calculate context budget
  const budgetTokens = Math.floor(modelConfig.contextWindow * modelConfig.targetUsage);

  // Find entities with similar embeddings
  const similarEntities = await graphService.findSimilarNodes(
    segmentEmbedding,
    documentId,
    userId,
    20
  );

  // Get entities with mentions in adjacent segments
  const adjacentEntityIds = new Set<string>();
  for (const segmentId of adjacentSegmentIds) {
    const mentionsInSegment = await mentionService.getBySegmentId(documentId, segmentId);
    for (const m of mentionsInSegment) {
      adjacentEntityIds.add(m.nodeId);
    }
  }

  // Combine and deduplicate
  const entityIds = new Set<string>();
  for (const s of similarEntities) {
    entityIds.add(s.id);
  }
  for (const id of adjacentEntityIds) {
    entityIds.add(id);
  }

  // Fetch full entity details
  const entities: Array<{
    id: string;
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentionCount: number;
    relevanceScore: number;
  }> = [];

  for (const id of entityIds) {
    const node = await graphService.getStoryNodeByIdInternal(id);
    if (!node) continue;

    const facets = await graphService.getFacetsForEntity(id);
    const mentionCount = await mentionService.getMentionCount(id);

    // Compute relevance score
    const similarEntry = similarEntities.find((s) => s.id === id);
    const embeddingSimilarity = similarEntry?.score || 0;
    const adjacentBoost = adjacentEntityIds.has(id) ? 0.2 : 0;
    const mentionBoost = Math.min(mentionCount / 100, 0.3);

    entities.push({
      id,
      name: node.name,
      type: node.type,
      facets: facets.map((f) => ({ type: f.type, content: f.content })),
      mentionCount,
      relevanceScore: embeddingSimilarity + adjacentBoost + mentionBoost,
    });
  }

  // Sort by relevance
  entities.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Select entities that fit in budget
  const selected: typeof entities = [];
  let tokenCount = 0;

  for (const entity of entities) {
    const formatted = formatEntityForContext(entity);
    const entityTokens = estimateTokens(formatted);

    if (tokenCount + entityTokens > budgetTokens) break;

    selected.push(entity);
    tokenCount += entityTokens;
  }

  return selected.map(({ relevanceScore, ...rest }) => rest);
}

export const graphStoryNodesRepository = {
  async getActiveNodes(documentId: string, userId: string): Promise<StoredStoryNode[]> {
    return graphService.getStoryNodesForDocument(documentId, userId);
  },

  async createNodes({
    userId,
    documentId,
    nodes,
    connections,
    narrativeThreads,
    documentContent,
    segments,
    versionNumber,
    documentStyle,
  }: CreateNodesParams): Promise<Map<string, string>> {
    const nodeNameToId = new Map<string, string>();

    for (const nodeData of nodes) {
      const nodeId = await graphService.createStoryNode(documentId, userId, nodeData, {
        stylePreset: documentStyle?.preset,
        stylePrompt: documentStyle?.prompt,
      });

      nodeNameToId.set(nodeData.name, nodeId);

      // Create mentions: use eventRanges for events, passages for other types
      if (nodeData.type === 'event' && nodeData.eventRanges?.length) {
        await createMentionsForEventRanges(
          nodeId,
          documentId,
          nodeData.eventRanges,
          documentContent,
          segments,
          versionNumber
        );
      } else {
        const processedPassages = nodeData.mentions.map((p) => processPassage(documentContent, p));
        await createMentionsForPassages(
          nodeId,
          documentId,
          processedPassages,
          segments,
          versionNumber
        );
      }

      // Run name matching to find comprehensive mentions
      try {
        const matchCount = await mentionService.runNameMatchingForNode(
          nodeId,
          documentId,
          documentContent,
          segments,
          versionNumber,
          nodeData.name,
          nodeData.aliases || []
        );
        if (matchCount > 0) {
          logger.info(
            { nodeId, nodeName: nodeData.name, matchCount },
            'Name matching found additional mentions'
          );
        }
      } catch (err) {
        logger.warn({ nodeId, error: err }, 'Name matching failed');
      }

      // Compute documentOrder from mention positions
      await updateDocumentOrderFromMentions(nodeId, segments);

      // Build embedding text from stored node + extraction mentions
      try {
        const storedNode = await graphService.getStoryNodeByIdInternal(nodeId);
        if (storedNode) {
          const extractionMentions = await mentionService.getByNodeIdAndSource(
            nodeId,
            'extraction'
          );
          const text = buildEmbeddingText(storedNode, extractionMentions);
          const embedding = await generateEmbedding(text);
          await graphService.setNodeEmbedding(nodeId, embedding);
        }
      } catch (err) {
        logger.warn({ nodeId, error: err }, 'Embedding generation failed');
      }
    }

    // Create connections with typed edges
    await this.createConnections({ connections, nodeNameToId });

    // Create narrative threads
    if (narrativeThreads?.length) {
      for (const thread of narrativeThreads) {
        const threadId = await graphService.createNarrativeThread(documentId, userId, thread);
        for (const [i, eventName] of thread.eventNames.entries()) {
          const eventId = nodeNameToId.get(eventName);
          if (eventId) await graphService.linkEventToThread(eventId, threadId, i);
        }
      }
    }

    return nodeNameToId;
  },

  /**
   * Create nodes using the facet-first model.
   * Facets are stored as separate nodes connected via HAS_FACET edges.
   * Entity description is derived by summarizing facets.
   * Entity embedding is computed as weighted average of facet embeddings.
   * Mentions are linked to facets when mention text matches facet content.
   */
  async createNodesWithFacets({
    userId,
    documentId,
    nodes,
    connections,
    narrativeThreads,
    documentContent,
    segments,
    versionNumber,
    documentStyle,
  }: CreateNodesWithFacetsParams): Promise<Map<string, string>> {
    const nodeNameToId = new Map<string, string>();

    for (const nodeData of nodes) {
      // Derive description from facets
      const description = deriveDescriptionFromFacets(nodeData.facets);

      // Derive main name from name facets (most common, under 40 chars)
      const mainName = deriveMainNameFromFacets(nodeData.facets, nodeData.name);

      // Create the entity node (without aliases - facets replace them)
      const entityNodeResult: StoryNodeResult = {
        type: nodeData.type,
        name: mainName,
        description,
        mentions: nodeData.mentions,
        metadata: nodeData.metadata,
        documentOrder: nodeData.documentOrder,
        eventRanges: nodeData.eventRanges,
      };

      const nodeId = await graphService.createStoryNode(documentId, userId, entityNodeResult, {
        stylePreset: documentStyle?.preset,
        stylePrompt: documentStyle?.prompt,
      });

      nodeNameToId.set(nodeData.name, nodeId);

      // Create facets and track content -> facetId mapping for mention linking
      const facetEmbeddings: { embedding: number[]; weight: number }[] = [];
      const facetContentToId = new Map<string, string>();

      for (const facet of nodeData.facets) {
        try {
          const facetEmbedding = await generateEmbedding(facet.content);
          const facetId = await graphService.createFacet(nodeId, facet, facetEmbedding);

          // Track facet content -> ID for mention linking
          facetContentToId.set(facet.content.toLowerCase(), facetId);

          // Weight by facet type: names contribute more to identity
          const weight = facet.type === 'name' ? 2.0 : 1.0;
          facetEmbeddings.push({ embedding: facetEmbedding, weight });

          logger.debug({ facetId, nodeId, type: facet.type }, 'Created facet');
        } catch (err) {
          logger.warn({ nodeId, facet, error: err }, 'Failed to create facet');
        }
      }

      // Compute entity embedding as weighted average of facet embeddings
      if (facetEmbeddings.length > 0) {
        const entityEmbedding = computeWeightedAverageEmbedding(facetEmbeddings);
        await graphService.setNodeEmbedding(nodeId, entityEmbedding);
      }

      // Create mentions: use eventRanges for events, passages for other types
      if (nodeData.type === 'event' && nodeData.eventRanges?.length) {
        await createMentionsForEventRanges(
          nodeId,
          documentId,
          nodeData.eventRanges,
          documentContent,
          segments,
          versionNumber
        );
      } else {
        const processedPassages = nodeData.mentions.map((p) => processPassage(documentContent, p));
        await createMentionsForPassagesWithFacets(
          nodeId,
          documentId,
          processedPassages,
          segments,
          versionNumber,
          facetContentToId
        );
      }

      // Run name matching using all name facets - link to first name facet
      const nameFacets = nodeData.facets.filter((f) => f.type === 'name');
      const primaryNameFacetId = nameFacets.length > 0
        ? facetContentToId.get(nameFacets[0].content.toLowerCase())
        : undefined;

      if (nameFacets.length > 0) {
        try {
          const matchCount = await runNameMatchingWithFacet(
            nodeId,
            documentId,
            documentContent,
            segments,
            versionNumber,
            mainName,
            nameFacets.map((f) => f.content).filter((n) => n !== mainName),
            primaryNameFacetId
          );
          if (matchCount > 0) {
            logger.info(
              { nodeId, nodeName: mainName, matchCount },
              'Name matching found additional mentions'
            );
          }
        } catch (err) {
          logger.warn({ nodeId, error: err }, 'Name matching failed');
        }
      }

      // Compute documentOrder from mention positions
      await updateDocumentOrderFromMentions(nodeId, segments);
    }

    // Create connections with typed edges
    const storyConnections: StoryConnectionResult[] = connections.map((c) => ({
      ...c,
      edgeType: c.edgeType || 'RELATED_TO',
    }));
    await this.createConnections({ connections: storyConnections, nodeNameToId });

    // Create narrative threads
    if (narrativeThreads?.length) {
      for (const thread of narrativeThreads) {
        const threadId = await graphService.createNarrativeThread(documentId, userId, thread);
        for (const [i, eventName] of thread.eventNames.entries()) {
          const eventId = nodeNameToId.get(eventName);
          if (eventId) await graphService.linkEventToThread(eventId, threadId, i);
        }
      }
    }

    return nodeNameToId;
  },

  async createConnections({ connections, nodeNameToId }: CreateConnectionsParams): Promise<number> {
    let created = 0;

    for (const connData of connections) {
      const fromId = nodeNameToId.get(connData.fromName);
      const toId = nodeNameToId.get(connData.toName);

      if (fromId && toId) {
        try {
          await graphService.createStoryConnection(
            fromId,
            toId,
            connData.edgeType || 'RELATED_TO',
            connData.description,
            { strength: connData.strength }
          );
          created++;
          logger.info(
            { from: connData.fromName, to: connData.toName, edgeType: connData.edgeType },
            'Story node connection created'
          );
        } catch (error: any) {
          // Skip connections that would create cycles (Gemini sometimes suggests these)
          if (error?.message?.includes('would create a cycle')) {
            logger.warn(
              { from: connData.fromName, to: connData.toName, edgeType: connData.edgeType },
              'Skipping connection that would create cycle'
            );
          } else {
            throw error;
          }
        }
      } else {
        logger.warn(
          { from: connData.fromName, to: connData.toName },
          'Connection references unknown node(s)'
        );
      }
    }

    return created;
  },

  async deleteAllForDocument(documentId: string, userId: string): Promise<void> {
    await graphService.deleteAllStoryNodesForDocument(documentId, userId);
  },

  /**
   * Resolve candidate nodes against existing nodes.
   * Returns mapping of candidate names to resolved IDs (existing or new).
   *
   * Resolution priority:
   * 1. Exact name match (case-insensitive)
   * 2. Alias match
   * 3. Embedding similarity (>0.92 threshold)
   * 4. Create new entity
   */
  async resolveEntities(
    documentId: string,
    userId: string,
    candidates: StoryNodeResult[],
    existingNodes: StoredStoryNode[]
  ): Promise<EntityResolutionResult> {
    const resolved: ResolvedEntity[] = [];
    const existingNodesByNameLower = new Map<string, StoredStoryNode>();
    const existingNodesByAliasLower = new Map<string, StoredStoryNode>();

    for (const node of existingNodes) {
      existingNodesByNameLower.set(node.name.toLowerCase(), node);
      if (node.aliases) {
        for (const alias of node.aliases) {
          existingNodesByAliasLower.set(alias.toLowerCase(), node);
        }
      }
    }

    const matchedExistingIds = new Set<string>();

    for (const candidate of candidates) {
      const candidateNameLower = candidate.name.toLowerCase();

      // 1. Exact name match
      const exactMatch = existingNodesByNameLower.get(candidateNameLower);
      if (exactMatch) {
        resolved.push({
          candidateName: candidate.name,
          resolvedId: exactMatch.id,
          matchType: 'exact_name',
          isNew: false,
          matchedExistingName: exactMatch.name,
        });
        matchedExistingIds.add(exactMatch.id);
        continue;
      }

      // 2. Alias match - check if candidate name matches an existing alias
      const aliasMatch = existingNodesByAliasLower.get(candidateNameLower);
      if (aliasMatch && !matchedExistingIds.has(aliasMatch.id)) {
        resolved.push({
          candidateName: candidate.name,
          resolvedId: aliasMatch.id,
          matchType: 'alias',
          isNew: false,
          matchedExistingName: aliasMatch.name,
        });
        matchedExistingIds.add(aliasMatch.id);
        continue;
      }

      // 2b. Check if any candidate alias matches an existing node name
      let foundAliasMatch: StoredStoryNode | undefined;
      if (candidate.aliases) {
        for (const alias of candidate.aliases) {
          const match = existingNodesByNameLower.get(alias.toLowerCase());
          if (match && !matchedExistingIds.has(match.id)) {
            foundAliasMatch = match;
            break;
          }
        }
      }
      if (foundAliasMatch) {
        resolved.push({
          candidateName: candidate.name,
          resolvedId: foundAliasMatch.id,
          matchType: 'alias',
          isNew: false,
          matchedExistingName: foundAliasMatch.name,
        });
        matchedExistingIds.add(foundAliasMatch.id);
        continue;
      }

      // 3. Embedding similarity (high threshold auto-merge)
      const embeddingText = `${candidate.name}: ${candidate.description || ''}`;
      try {
        const embedding = await generateEmbedding(embeddingText);
        const similar = await graphService.findSimilarNodes(embedding, documentId, userId, 5);

        const bestMatch = similar.find(
          (s) => s.score > 0.92 && !matchedExistingIds.has(s.id)
        );

        if (bestMatch) {
          resolved.push({
            candidateName: candidate.name,
            resolvedId: bestMatch.id,
            matchType: 'embedding',
            isNew: false,
            matchedExistingName: bestMatch.name,
            similarity: bestMatch.score,
          });
          matchedExistingIds.add(bestMatch.id);
          logger.info(
            {
              candidateName: candidate.name,
              matchedName: bestMatch.name,
              similarity: bestMatch.score,
            },
            'Entity resolved via embedding similarity'
          );
          continue;
        }
      } catch (err) {
        logger.warn({ candidate: candidate.name, error: err }, 'Embedding similarity check failed');
      }

      // 4. No match - create new entity
      resolved.push({
        candidateName: candidate.name,
        resolvedId: randomUUID(),
        matchType: 'new',
        isNew: true,
      });
    }

    // Identify entities to soft-delete (exist in graph but not in new extraction)
    const preservedIds = new Set(resolved.filter((r) => !r.isNew).map((r) => r.resolvedId));
    const softDeleted: string[] = [];

    for (const existing of existingNodes) {
      if (!preservedIds.has(existing.id)) {
        softDeleted.push(existing.id);
      }
    }

    return {
      resolved,
      preserved: Array.from(preservedIds),
      softDeleted,
    };
  },

  async applyUpdates({
    userId,
    documentId,
    documentContent,
    segments,
    versionNumber,
    existingNodes,
    updates,
    documentStyle,
  }: ApplyUpdatesParams): Promise<{ added: number; updated: number; deleted: number }> {
    let added = 0;
    let updated = 0;
    let deleted = 0;

    const newNodeIds = new Map<string, string>();
    const existingNodeMap = new Map(existingNodes.map((n) => [n.name, n.id]));

    // 1. Soft delete nodes and their mentions
    for (const nodeId of updates.delete) {
      await graphService.softDeleteStoryNode(nodeId);
      await mentionService.deleteByNodeId(nodeId);
      deleted++;
    }
    if (updates.delete.length > 0) {
      logger.info({ ids: updates.delete }, 'Soft deleted nodes and mentions');
    }

    // 2. Update existing nodes
    for (const update of updates.update) {
      const updateFields: {
        name?: string;
        description?: string;
        aliases?: string[];
      } = {};

      if (update.name !== undefined) updateFields.name = update.name;
      if (update.description !== undefined) updateFields.description = update.description;
      if (update.aliases !== undefined) updateFields.aliases = update.aliases;

      let processedPassages: (TextPosition | { text: string })[] | undefined;
      if (update.mentions !== undefined) {
        processedPassages = update.mentions.map((p) => processPassage(documentContent, p));
      }

      await graphService.updateStoryNode(update.id, updateFields);
      updated++;

      // Update mentions if mentions changed
      if (processedPassages !== undefined) {
        await mentionService.deleteByNodeId(update.id);
        await createMentionsForPassages(
          update.id,
          documentId,
          processedPassages,
          segments,
          versionNumber
        );

        // Run name matching for updated nodes
        const node = await graphService.getStoryNodeByIdInternal(update.id);
        const nodeName = update.name !== undefined ? update.name : node?.name;
        const aliases = update.aliases !== undefined ? update.aliases : node?.aliases;
        if (nodeName) {
          try {
            const matchCount = await mentionService.runNameMatchingForNode(
              update.id,
              documentId,
              documentContent,
              segments,
              versionNumber,
              nodeName,
              aliases || []
            );
            if (matchCount > 0) {
              logger.info(
                { nodeId: update.id, nodeName, matchCount },
                'Name matching found additional mentions on update'
              );
            }
          } catch (err) {
            logger.warn({ nodeId: update.id, error: err }, 'Name matching failed on update');
          }
        }

        // Recompute documentOrder from new mentions
        await updateDocumentOrderFromMentions(update.id, segments);
      }

      // Re-embed if name or description changed
      if (update.name !== undefined || update.description !== undefined) {
        try {
          const node = await graphService.getStoryNodeByIdInternal(update.id);
          if (node) {
            const extractionMentions = await mentionService.getByNodeIdAndSource(
              update.id,
              'extraction'
            );
            const text = buildEmbeddingText(node, extractionMentions);
            const embedding = await generateEmbedding(text);
            await graphService.setNodeEmbedding(update.id, embedding);
          }
        } catch (err) {
          logger.warn({ nodeId: update.id, error: err }, 'Re-embedding failed on update');
        }
      }
    }

    // 3. Add new nodes
    for (const nodeData of updates.add) {
      const nodeId = await graphService.createStoryNode(documentId, userId, nodeData, {
        stylePreset: documentStyle?.preset,
        stylePrompt: documentStyle?.prompt,
      });

      newNodeIds.set(nodeData.name, nodeId);
      added++;
      logger.info({ nodeId, nodeName: nodeData.name }, 'New story node created');

      // Create mentions: use eventRanges for events, passages for other types
      if (nodeData.type === 'event' && nodeData.eventRanges?.length) {
        await createMentionsForEventRanges(
          nodeId,
          documentId,
          nodeData.eventRanges,
          documentContent,
          segments,
          versionNumber
        );
      } else {
        const processedPassages = nodeData.mentions.map((p) => processPassage(documentContent, p));
        await createMentionsForPassages(
          nodeId,
          documentId,
          processedPassages,
          segments,
          versionNumber
        );
      }

      // Run name matching to find comprehensive mentions
      try {
        const matchCount = await mentionService.runNameMatchingForNode(
          nodeId,
          documentId,
          documentContent,
          segments,
          versionNumber,
          nodeData.name,
          nodeData.aliases || []
        );
        if (matchCount > 0) {
          logger.info(
            { nodeId, nodeName: nodeData.name, matchCount },
            'Name matching found additional mentions'
          );
        }
      } catch (err) {
        logger.warn({ nodeId, error: err }, 'Name matching failed');
      }

      // Compute documentOrder from mention positions
      await updateDocumentOrderFromMentions(nodeId, segments);

      // Build embedding text from stored node + extraction mentions
      try {
        const storedNode = await graphService.getStoryNodeByIdInternal(nodeId);
        if (storedNode) {
          const extractionMentions = await mentionService.getByNodeIdAndSource(
            nodeId,
            'extraction'
          );
          const text = buildEmbeddingText(storedNode, extractionMentions);
          const embedding = await generateEmbedding(text);
          await graphService.setNodeEmbedding(nodeId, embedding);
        }
      } catch (err) {
        logger.warn({ nodeId, error: err }, 'Embedding generation failed');
      }
    }

    // 4. Handle connection deletes
    for (const connDel of updates.connectionUpdates.delete) {
      await graphService.softDeleteStoryConnection(connDel.fromId, connDel.toId);
    }

    // 5. Handle connection adds
    for (const connAdd of updates.connectionUpdates.add) {
      const fromId =
        connAdd.fromId ||
        existingNodeMap.get(connAdd.fromName || '') ||
        newNodeIds.get(connAdd.fromName || '');
      const toId =
        connAdd.toId ||
        existingNodeMap.get(connAdd.toName || '') ||
        newNodeIds.get(connAdd.toName || '');

      if (fromId && toId) {
        await graphService.createStoryConnection(
          fromId,
          toId,
          connAdd.edgeType || 'RELATED_TO',
          connAdd.description,
          { strength: connAdd.strength }
        );
        logger.info({ fromId, toId, edgeType: connAdd.edgeType }, 'New connection created');
      } else {
        logger.warn({ connAdd }, 'Could not resolve connection node IDs');
      }
    }

    // 6. Handle narrative threads
    if (updates.narrativeThreads?.length) {
      for (const thread of updates.narrativeThreads) {
        const threadId = await graphService.createNarrativeThread(documentId, userId, thread);
        for (const [i, eventName] of thread.eventNames.entries()) {
          const eventId = existingNodeMap.get(eventName) || newNodeIds.get(eventName);
          if (eventId) await graphService.linkEventToThread(eventId, threadId, i);
        }
      }
    }

    return { added, updated, deleted };
  },

  async getConnectionsForDocument(documentId: string) {
    return graphService.getStoryConnectionsForDocument(documentId);
  },
};

function processPassage(
  content: string,
  passage: StoryNodeMention
): TextPosition | { text: string } {
  // Try exact match first (fast path)
  const exactIndex = content.indexOf(passage.text);
  if (exactIndex !== -1) {
    return {
      start: exactIndex,
      end: exactIndex + passage.text.length,
      text: passage.text,
    };
  }

  // Fall back to fuzzy matching
  const fuzzyResult = fuzzyFindText(content, {
    sourceText: passage.text,
    originalStart: 0,
    originalEnd: passage.text.length,
  });

  if (fuzzyResult && fuzzyResult.confidence >= 0.5) {
    // Extract actual text at matched position
    const actualText = content.slice(fuzzyResult.start, fuzzyResult.end);

    // Validate the match
    const isValid = validateNearMatch(passage.text, actualText, fuzzyResult.confidence);

    if (isValid) {
      logger.info(
        {
          llmText: passage.text.slice(0, 50),
          actualText: actualText.slice(0, 50),
          confidence: fuzzyResult.confidence,
        },
        'Passage located and corrected via fuzzy matching'
      );
      // Store ACTUAL document text, not LLM's version
      return {
        start: fuzzyResult.start,
        end: fuzzyResult.end,
        text: actualText,
      };
    }
  }

  logger.warn(
    { passageText: passage.text, fuzzyConfidence: fuzzyResult?.confidence },
    'Passage text not found or validation failed'
  );
  return { text: passage.text };
}

/**
 * Validate that fuzzy-matched text is close enough to LLM-provided text.
 * Uses length-based tolerance (longer texts = more lenient).
 */
function validateNearMatch(llmText: string, actualText: string, confidence: number): boolean {
  // Minimum confidence threshold
  if (confidence < 0.5) return false;

  // Allow more deviation for longer texts
  const lengthRatio =
    Math.abs(llmText.length - actualText.length) / Math.max(llmText.length, actualText.length);
  const maxLengthDeviation = llmText.length > 100 ? 0.3 : llmText.length > 50 ? 0.2 : 0.1;

  if (lengthRatio > maxLengthDeviation) return false;

  return true;
}

export function parsePassages(mentions: unknown): StoryNodeMention[] {
  if (!mentions) return [];
  try {
    const parsed = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Create mentions in Postgres for mentions that have valid positions.
 */
async function createMentionsForPassages(
  nodeId: string,
  documentId: string,
  processedPassages: (TextPosition | { text: string })[],
  segments: Segment[],
  versionNumber: number
): Promise<void> {
  for (const passage of processedPassages) {
    if (!isTextPosition(passage)) continue;

    const relative = segmentService.toRelativePosition(segments, passage.start, passage.end);

    if (!relative) {
      logger.warn(
        { nodeId, start: passage.start, end: passage.end },
        'Could not map passage to segment'
      );
      continue;
    }

    try {
      await mentionService.create({
        nodeId,
        documentId,
        segmentId: relative.segmentId,
        relativeStart: relative.relativeStart,
        relativeEnd: relative.relativeEnd,
        originalText: passage.text,
        versionNumber,
        source: 'extraction',
        confidence: 100,
      });
    } catch (err) {
      logger.warn({ nodeId, error: err }, 'Failed to create mention');
    }
  }
}

function isTextPosition(p: TextPosition | { text: string }): p is TextPosition {
  return 'start' in p && 'end' in p;
}

/**
 * Create mentions for event ranges by locating start/end markers and creating
 * a mention spanning the full range.
 */
async function createMentionsForEventRanges(
  nodeId: string,
  documentId: string,
  eventRanges: EventRange[],
  documentContent: string,
  segments: Segment[],
  versionNumber: number
): Promise<void> {
  for (const range of eventRanges) {
    const startResult = processPassage(documentContent, { text: range.startMarker });
    const endResult = processPassage(documentContent, { text: range.endMarker });

    if (isTextPosition(startResult) && isTextPosition(endResult)) {
      const startPosition = startResult.start;
      const endPosition = endResult.end;

      if (startPosition >= endPosition) {
        logger.warn(
          { nodeId, startMarker: range.startMarker, endMarker: range.endMarker },
          'Event range markers are out of order (start >= end)'
        );
        continue;
      }

      const rangeText = documentContent.slice(startPosition, endPosition);

      const mention = await mentionService.createFromAbsolutePosition(
        nodeId,
        documentId,
        startPosition,
        endPosition,
        rangeText,
        versionNumber,
        segments,
        'extraction',
        100
      );

      if (!mention) {
        logger.warn(
          { nodeId, startPosition, endPosition },
          'Could not create mention for event range'
        );
      }
    } else {
      logger.warn(
        {
          nodeId,
          startMarker: range.startMarker,
          endMarker: range.endMarker,
          startFound: isTextPosition(startResult),
          endFound: isTextPosition(endResult),
        },
        'Could not locate event range markers'
      );
    }
  }
}

/**
 * Compute documentOrder from mentions and update the node.
 * documentOrder = min(absolutePosition) across all mentions.
 */
async function updateDocumentOrderFromMentions(nodeId: string, segments: Segment[]): Promise<void> {
  const firstPosition = await mentionService.getFirstPosition(nodeId, segments);

  if (firstPosition !== null) {
    await graphService.updateStoryNode(nodeId, { documentOrder: firstPosition });
    logger.debug({ nodeId, documentOrder: firstPosition }, 'Updated documentOrder from mentions');
  }
}

/**
 * Derive a description from facets by concatenating appearance and trait facets.
 * For image generation, only appearance facets are truly relevant.
 */
function deriveDescriptionFromFacets(facets: FacetInput[]): string {
  const appearanceFacets = facets.filter((f) => f.type === 'appearance');
  const traitFacets = facets.filter((f) => f.type === 'trait');

  const parts: string[] = [];

  if (appearanceFacets.length > 0) {
    parts.push(appearanceFacets.map((f) => f.content).join(', '));
  }

  if (traitFacets.length > 0) {
    parts.push(traitFacets.map((f) => f.content).join(', '));
  }

  return parts.join('. ') || '';
}

/**
 * Derive main name from name facets.
 * Picks the most common name under 40 chars, or falls back to original.
 */
function deriveMainNameFromFacets(facets: FacetInput[], originalName: string): string {
  const nameFacets = facets.filter((f) => f.type === 'name' && f.content.length < 40);

  if (nameFacets.length === 0) {
    return originalName;
  }

  // For now, return the first name facet (typically the primary name)
  // In future, could use mention counts to pick most frequently mentioned
  return nameFacets[0].content;
}

/**
 * Compute weighted average of embeddings.
 * Each embedding is multiplied by its weight, summed, then normalized.
 */
function computeWeightedAverageEmbedding(
  embeddings: { embedding: number[]; weight: number }[]
): number[] {
  if (embeddings.length === 0) {
    throw new Error('Cannot compute average of zero embeddings');
  }

  const dim = embeddings[0].embedding.length;
  const result = new Array(dim).fill(0);
  let totalWeight = 0;

  for (const { embedding, weight } of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += embedding[i] * weight;
    }
    totalWeight += weight;
  }

  // Normalize by total weight
  for (let i = 0; i < dim; i++) {
    result[i] /= totalWeight;
  }

  // L2 normalize the result
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

/**
 * Create mentions with facet linking.
 * Attempts to match mention text to facet content and links via facetId.
 */
async function createMentionsForPassagesWithFacets(
  nodeId: string,
  documentId: string,
  processedPassages: (TextPosition | { text: string })[],
  segments: Segment[],
  versionNumber: number,
  facetContentToId: Map<string, string>
): Promise<void> {
  for (const passage of processedPassages) {
    if (!isTextPosition(passage)) continue;

    const relative = segmentService.toRelativePosition(segments, passage.start, passage.end);

    if (!relative) {
      logger.warn(
        { nodeId, start: passage.start, end: passage.end },
        'Could not map passage to segment'
      );
      continue;
    }

    const facetId = findMatchingFacet(passage.text, facetContentToId);

    try {
      await mentionService.create({
        nodeId,
        documentId,
        segmentId: relative.segmentId,
        facetId,
        relativeStart: relative.relativeStart,
        relativeEnd: relative.relativeEnd,
        originalText: passage.text,
        versionNumber,
        source: 'extraction',
        confidence: 100,
      });
    } catch (err) {
      logger.warn({ nodeId, error: err }, 'Failed to create mention');
    }
  }
}

function findMatchingFacet(
  mentionText: string,
  facetContentToId: Map<string, string>
): string | null {
  const mentionLower = mentionText.toLowerCase();

  if (facetContentToId.has(mentionLower)) {
    return facetContentToId.get(mentionLower)!;
  }

  for (const [facetContent, facetId] of facetContentToId) {
    if (mentionLower.includes(facetContent) || facetContent.includes(mentionLower)) {
      return facetId;
    }
  }

  return null;
}

/**
 * Run name matching and link mentions to a specific facet.
 */
/**
 * Recompute entity embedding weighted by mention counts.
 * Call this AFTER all mentions are created for accurate weighting.
 */
export async function recomputeEntityEmbeddingWithMentionWeights(
  nodeId: string
): Promise<void> {
  // Get all facets for this entity
  const facets = await graphService.getFacetsForEntity(nodeId);

  if (facets.length === 0) {
    logger.warn({ nodeId }, 'No facets found for entity embedding recomputation');
    return;
  }

  // Get mention counts by facet
  const mentionCounts = await mentionService.getMentionCountsByFacet(nodeId);

  // Build weighted embedding array
  const facetEmbeddings: { embedding: number[]; weight: number }[] = [];

  for (const facet of facets) {
    if (!facet.embedding) continue;

    // Weight = mention count (minimum 1) + type bonus for names
    const mentionCount = mentionCounts.get(facet.id) || 1;
    const typeBonus = facet.type === 'name' ? 2.0 : 1.0;
    const weight = mentionCount * typeBonus;

    facetEmbeddings.push({
      embedding: facet.embedding,
      weight,
    });
  }

  if (facetEmbeddings.length === 0) {
    logger.warn({ nodeId }, 'No facet embeddings found for entity');
    return;
  }

  // Compute weighted average
  const entityEmbedding = computeWeightedAverageEmbedding(facetEmbeddings);
  await graphService.setNodeEmbedding(nodeId, entityEmbedding);

  logger.info(
    { nodeId, facetCount: facetEmbeddings.length, totalWeight: facetEmbeddings.reduce((s, e) => s + e.weight, 0) },
    'Entity embedding recomputed with mention weights'
  );
}

async function runNameMatchingWithFacet(
  nodeId: string,
  documentId: string,
  documentContent: string,
  segments: Segment[],
  versionNumber: number,
  name: string,
  aliases: string[],
  facetId?: string
): Promise<number> {
  // Get existing mentions to exclude their spans
  const existingMentions = await mentionService.getByNodeIdWithAbsolutePositions(nodeId, segments);
  const excludeSpans = existingMentions.map((m) => ({
    start: m.absoluteStart,
    end: m.absoluteEnd,
  }));

  // Find name occurrences
  const { findNameOccurrences, nameMatchesToMentionInputs } = await import('../mentions/nameMatch.js');
  const matches = findNameOccurrences(documentContent, name, aliases, {
    excludeExistingSpans: excludeSpans,
    minConfidence: 70,
  });

  if (matches.length === 0) return 0;

  // Convert to mention inputs with facetId
  const inputs = nameMatchesToMentionInputs(nodeId, documentId, matches, segments, versionNumber);

  // Add facetId to each input
  const inputsWithFacet = inputs.map((input) => ({
    ...input,
    facetId: facetId ?? null,
  }));

  await mentionService.createBatch(inputsWithFacet);
  return inputsWithFacet.length;
}

/**
 * Graph-backed repository for story node and connection persistence.
 * Drop-in replacement for repository.ts, using FalkorDB instead of Postgres.
 */
import { graphService, type StoredStoryNode } from '../graph/graph.service';
import { generateEmbedding, buildEmbeddingText } from '../embeddings';
import { segmentService, type Segment } from '../segments';
import { mentionService, fuzzyFindText } from '../mentions';
import { logger } from '../../utils/logger';
import type {
  StoryNodeResult,
  StoryNodeMention,
  StoryConnectionResult,
  NarrativeThreadResult,
  NodeUpdate,
  ConnectionUpdate,
  TextPosition,
} from '../../types/storyNodes';

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
      const processedPassages = nodeData.mentions.map((p) => processPassage(documentContent, p));

      const nodeId = await graphService.createStoryNode(
        documentId,
        userId,
        nodeData,
        {
          stylePreset: documentStyle?.preset,
          stylePrompt: documentStyle?.prompt,
        }
      );

      nodeNameToId.set(nodeData.name, nodeId);

      // Create mentions for mentions with valid positions
      await createMentionsForPassages(
        nodeId,
        documentId,
        processedPassages,
        segments,
        versionNumber
      );

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
          const extractionMentions = await mentionService.getByNodeIdAndSource(nodeId, 'extraction');
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

  async createConnections({ connections, nodeNameToId }: CreateConnectionsParams): Promise<number> {
    let created = 0;

    for (const connData of connections) {
      const fromId = nodeNameToId.get(connData.fromName);
      const toId = nodeNameToId.get(connData.toName);

      if (fromId && toId) {
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
            const extractionMentions = await mentionService.getByNodeIdAndSource(update.id, 'extraction');
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
      const processedPassages = nodeData.mentions.map((p) => processPassage(documentContent, p));

      const nodeId = await graphService.createStoryNode(
        documentId,
        userId,
        nodeData,
        {
          stylePreset: documentStyle?.preset,
          stylePrompt: documentStyle?.prompt,
        }
      );

      newNodeIds.set(nodeData.name, nodeId);
      added++;
      logger.info({ nodeId, nodeName: nodeData.name }, 'New story node created');

      // Create mentions for mentions
      await createMentionsForPassages(
        nodeId,
        documentId,
        processedPassages,
        segments,
        versionNumber
      );

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
          const extractionMentions = await mentionService.getByNodeIdAndSource(nodeId, 'extraction');
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

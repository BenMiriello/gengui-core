/**
 * Graph-backed repository for story node and connection persistence.
 * Drop-in replacement for repository.ts, using FalkorDB instead of Postgres.
 */
import { graphService, type StoredStoryNode } from '../graph/graph.service';
import { generateEmbedding, buildEmbeddingText } from '../embeddings';
import { logger } from '../../utils/logger';
import type {
  StoryNodeResult,
  StoryNodePassage,
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
    documentStyle,
  }: CreateNodesParams): Promise<Map<string, string>> {
    const nodeNameToId = new Map<string, string>();

    for (const nodeData of nodes) {
      const processedPassages = nodeData.passages.map(p =>
        processPassage(documentContent, p)
      );

      const nodeWithProcessedPassages: StoryNodeResult = {
        ...nodeData,
        passages: processedPassages as StoryNodePassage[],
      };

      const nodeId = await graphService.createStoryNode(
        documentId,
        userId,
        nodeWithProcessedPassages,
        {
          stylePreset: documentStyle?.preset,
          stylePrompt: documentStyle?.prompt,
        }
      );

      nodeNameToId.set(nodeData.name, nodeId);

      try {
        const text = buildEmbeddingText(nodeData);
        const embedding = await generateEmbedding(text);
        await graphService.setNodeEmbedding(nodeId, embedding);
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

  async createConnections({
    connections,
    nodeNameToId,
  }: CreateConnectionsParams): Promise<number> {
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
        logger.info({ from: connData.fromName, to: connData.toName, edgeType: connData.edgeType }, 'Story node connection created');
      } else {
        logger.warn({ from: connData.fromName, to: connData.toName }, 'Connection references unknown node(s)');
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
    existingNodes,
    updates,
    documentStyle,
  }: ApplyUpdatesParams): Promise<{ added: number; updated: number; deleted: number }> {
    let added = 0;
    let updated = 0;
    let deleted = 0;

    const newNodeIds = new Map<string, string>();
    const existingNodeMap = new Map(existingNodes.map(n => [n.name, n.id]));

    // 1. Soft delete nodes
    for (const nodeId of updates.delete) {
      await graphService.softDeleteStoryNode(nodeId);
      deleted++;
    }
    if (updates.delete.length > 0) {
      logger.info({ ids: updates.delete }, 'Soft deleted nodes');
    }

    // 2. Update existing nodes
    for (const update of updates.update) {
      const updateFields: {
        name?: string;
        description?: string;
        passages?: StoryNodePassage[];
      } = {};

      if (update.name !== undefined) updateFields.name = update.name;
      if (update.description !== undefined) updateFields.description = update.description;
      if (update.passages !== undefined) {
        updateFields.passages = update.passages.map(p =>
          processPassage(documentContent, p)
        ) as StoryNodePassage[];
      }

      await graphService.updateStoryNode(update.id, updateFields);
      updated++;

      // Re-embed if name or description changed
      if (update.name !== undefined || update.description !== undefined) {
        try {
          const node = await graphService.getStoryNodeByIdInternal(update.id);
          if (node) {
            const text = buildEmbeddingText(node);
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
      const processedPassages = nodeData.passages.map(p =>
        processPassage(documentContent, p)
      );

      const nodeWithProcessedPassages: StoryNodeResult = {
        ...nodeData,
        passages: processedPassages as StoryNodePassage[],
      };

      const nodeId = await graphService.createStoryNode(
        documentId,
        userId,
        nodeWithProcessedPassages,
        {
          stylePreset: documentStyle?.preset,
          stylePrompt: documentStyle?.prompt,
        }
      );

      newNodeIds.set(nodeData.name, nodeId);
      added++;
      logger.info({ nodeId, nodeName: nodeData.name }, 'New story node created');

      try {
        const text = buildEmbeddingText(nodeData);
        const embedding = await generateEmbedding(text);
        await graphService.setNodeEmbedding(nodeId, embedding);
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
      const fromId = connAdd.fromId || existingNodeMap.get(connAdd.fromName || '') || newNodeIds.get(connAdd.fromName || '');
      const toId = connAdd.toId || existingNodeMap.get(connAdd.toName || '') || newNodeIds.get(connAdd.toName || '');

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
  passage: StoryNodePassage
): TextPosition | { text: string } {
  const index = content.indexOf(passage.text);
  if (index !== -1) {
    return {
      start: index,
      end: index + passage.text.length,
      text: passage.text,
    };
  }
  logger.warn({ passageText: passage.text }, 'Passage text not found in document');
  return { text: passage.text };
}

export function parsePassages(passages: unknown): StoryNodePassage[] {
  if (!passages) return [];
  try {
    const parsed = typeof passages === 'string' ? JSON.parse(passages) : passages;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Repository for story node and connection persistence.
 * Handles all database operations for nodes and their relationships.
 */
import { db } from '../../config/database';
import { storyNodes, storyNodeConnections } from '../../models/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import type {
  StoryNodeResult,
  StoryNodePassage,
  StoryConnectionResult,
  NodeUpdate,
  ConnectionUpdate,
  TextPosition,
} from '../../types/storyNodes';

interface CreateNodesParams {
  userId: string;
  documentId: string;
  nodes: StoryNodeResult[];
  documentContent: string;
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
  };
}

export const storyNodesRepository = {
  /**
   * Fetch active (non-deleted) nodes for a document.
   */
  async getActiveNodes(documentId: string, userId: string) {
    return db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.documentId, documentId),
          eq(storyNodes.userId, userId),
          isNull(storyNodes.deletedAt)
        )
      );
  },

  /**
   * Create nodes from analysis results.
   * Returns map of node names to their created IDs.
   */
  async createNodes({
    userId,
    documentId,
    nodes,
    documentContent,
  }: CreateNodesParams): Promise<Map<string, string>> {
    const nodeNameToId = new Map<string, string>();

    for (const nodeData of nodes) {
      const passages = nodeData.passages.map(p =>
        processPassage(documentContent, p)
      );

      const [node] = await db
        .insert(storyNodes)
        .values({
          userId,
          documentId,
          type: nodeData.type,
          name: nodeData.name,
          description: nodeData.description,
          passages: JSON.stringify(passages),
          metadata: nodeData.metadata ? JSON.stringify(nodeData.metadata) : null,
        })
        .returning({ id: storyNodes.id, name: storyNodes.name });

      nodeNameToId.set(node.name, node.id);
      logger.info({ nodeId: node.id, nodeName: node.name, type: nodeData.type }, 'Story node created');
    }

    return nodeNameToId;
  },

  /**
   * Create connections between nodes.
   */
  async createConnections({
    connections,
    nodeNameToId,
  }: CreateConnectionsParams): Promise<number> {
    let created = 0;

    for (const connData of connections) {
      const fromId = nodeNameToId.get(connData.fromName);
      const toId = nodeNameToId.get(connData.toName);

      if (fromId && toId) {
        await db.insert(storyNodeConnections).values({
          fromNodeId: fromId,
          toNodeId: toId,
          description: connData.description,
        });
        created++;
        logger.info({ from: connData.fromName, to: connData.toName }, 'Story node connection created');
      } else {
        logger.warn({ from: connData.fromName, to: connData.toName }, 'Connection references unknown node(s)');
      }
    }

    return created;
  },

  /**
   * Hard delete all nodes for a document (for reanalysis).
   * Connections cascade via foreign key.
   */
  async deleteAllForDocument(documentId: string, userId: string): Promise<void> {
    await db
      .delete(storyNodes)
      .where(and(eq(storyNodes.documentId, documentId), eq(storyNodes.userId, userId)));
  },

  /**
   * Apply incremental updates to nodes and connections.
   */
  async applyUpdates({
    userId,
    documentId,
    documentContent,
    existingNodes,
    updates,
  }: ApplyUpdatesParams): Promise<{ added: number; updated: number; deleted: number }> {
    let added = 0;
    let updated = 0;
    let deleted = 0;

    const newNodeIds = new Map<string, string>();
    const existingNodeMap = new Map(existingNodes.map(n => [n.name, n.id]));

    // 1. Soft delete nodes
    if (updates.delete.length > 0) {
      await db
        .update(storyNodes)
        .set({ deletedAt: new Date() })
        .where(inArray(storyNodes.id, updates.delete));
      deleted = updates.delete.length;
      logger.info({ ids: updates.delete }, 'Soft deleted nodes');
    }

    // 2. Update existing nodes
    for (const update of updates.update) {
      const updateFields: Record<string, any> = { updatedAt: new Date() };

      if (update.name !== undefined) updateFields.name = update.name;
      if (update.description !== undefined) updateFields.description = update.description;
      if (update.passages !== undefined) {
        updateFields.passages = JSON.stringify(
          update.passages.map(p => processPassage(documentContent, p))
        );
      }

      await db
        .update(storyNodes)
        .set(updateFields)
        .where(eq(storyNodes.id, update.id));
      updated++;
    }

    // 3. Add new nodes
    for (const nodeData of updates.add) {
      const passages = nodeData.passages.map(p => processPassage(documentContent, p));

      const [node] = await db
        .insert(storyNodes)
        .values({
          userId,
          documentId,
          type: nodeData.type,
          name: nodeData.name,
          description: nodeData.description,
          passages: JSON.stringify(passages),
          metadata: nodeData.metadata ? JSON.stringify(nodeData.metadata) : null,
        })
        .returning({ id: storyNodes.id, name: storyNodes.name });

      newNodeIds.set(nodeData.name, node.id);
      added++;
      logger.info({ nodeId: node.id, nodeName: node.name }, 'New story node created');
    }

    // 4. Handle connection deletes
    for (const connDel of updates.connectionUpdates.delete) {
      await db
        .update(storyNodeConnections)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(storyNodeConnections.fromNodeId, connDel.fromId),
            eq(storyNodeConnections.toNodeId, connDel.toId)
          )
        );
    }

    // 5. Handle connection adds
    for (const connAdd of updates.connectionUpdates.add) {
      const fromId = connAdd.fromId || existingNodeMap.get(connAdd.fromName || '') || newNodeIds.get(connAdd.fromName || '');
      const toId = connAdd.toId || existingNodeMap.get(connAdd.toName || '') || newNodeIds.get(connAdd.toName || '');

      if (fromId && toId) {
        await db.insert(storyNodeConnections).values({
          fromNodeId: fromId,
          toNodeId: toId,
          description: connAdd.description,
        });
        logger.info({ fromId, toId }, 'New connection created');
      } else {
        logger.warn({ connAdd }, 'Could not resolve connection node IDs');
      }
    }

    return { added, updated, deleted };
  },
};

/**
 * Process a passage to find its position in the document.
 */
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

/**
 * Parse passages from database JSON.
 */
export function parsePassages(passages: unknown): StoryNodePassage[] {
  if (!passages) return [];
  try {
    const parsed = typeof passages === 'string' ? JSON.parse(passages) : passages;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

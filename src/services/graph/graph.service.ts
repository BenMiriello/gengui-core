import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type {
  StoryNodeResult,
  StoryNodePassage,
  StoryNodeType,
  StoryEdgeType,
  NarrativeThreadResult,
} from '../../types/storyNodes';

export interface NodeProperties {
  [key: string]: string | number | boolean | null;
}

export interface StoredStoryNode {
  id: string;
  documentId: string;
  userId: string;
  type: StoryNodeType;
  name: string;
  description: string | null;
  passages: string | null;
  metadata: string | null;
  primaryMediaId: string | null;
  stylePreset: string | null;
  stylePrompt: string | null;
  narrativeOrder: number | null;
  documentOrder: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StoredStoryConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: StoryEdgeType;
  description: string | null;
  strength: number | null;
  narrativeDistance: number | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface QueryResult {
  headers: string[];
  data: unknown[][];
  stats: Record<string, string>;
}

const GRAPH_NAME = 'gengui';

class GraphService {
  private client: Redis | null = null;
  private connectionPromise: Promise<void> | null = null;

  private getConnectionUrl(): string {
    return process.env.FALKORDB_URL || 'redis://localhost:6381';
  }

  async connect(): Promise<void> {
    if (this.client?.status === 'ready') {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.doConnect();
    return this.connectionPromise;
  }

  private async doConnect(): Promise<void> {
    const url = this.getConnectionUrl();
    logger.info({ url }, 'Connecting to FalkorDB');

    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      commandTimeout: 10000,
      connectTimeout: 5000,
      lazyConnect: false,
      family: 4,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FalkorDB connection timeout'));
      }, 10000);

      this.client!.once('ready', () => {
        clearTimeout(timeout);
        logger.info('FalkorDB connected');
        resolve();
      });

      this.client!.once('error', (err) => {
        clearTimeout(timeout);
        logger.error({ error: err }, 'FalkorDB connection error');
        reject(err);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connectionPromise = null;
      logger.info('FalkorDB disconnected');
    }
  }

  private async ensureConnected(): Promise<Redis> {
    if (!this.client || this.client.status !== 'ready') {
      await this.connect();
    }
    return this.client!;
  }

  /**
   * Execute a Cypher query against FalkorDB
   */
  async query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const client = await this.ensureConnected();

    let queryString = cypher;
    if (params && Object.keys(params).length > 0) {
      const cypherParams = `CYPHER ${Object.entries(params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')} `;
      queryString = cypherParams + cypher;
    }

    const result = await client.call('GRAPH.QUERY', GRAPH_NAME, queryString) as unknown[];

    return this.parseResult(result);
  }

  private parseResult(result: unknown[]): QueryResult {
    if (!Array.isArray(result) || result.length < 2) {
      return { headers: [], data: [], stats: {} };
    }

    const headers = Array.isArray(result[0]) ? result[0] as string[] : [];
    const data = Array.isArray(result[1]) ? result[1] as unknown[][] : [];
    const statsArray = Array.isArray(result[2]) ? result[2] as string[] : [];

    const stats: Record<string, string> = {};
    for (const stat of statsArray) {
      const [key, value] = stat.split(':').map(s => s.trim());
      if (key && value) {
        stats[key] = value;
      }
    }

    return { headers, data, stats };
  }

  /**
   * Create a node with the given type (label) and properties
   * Returns the internal node ID
   */
  async createNode(type: string, props: NodeProperties): Promise<string> {
    const propsString = this.propsToString(props);
    const cypher = `CREATE (n:${type} ${propsString}) RETURN id(n) as nodeId`;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create node');
    }

    return String(result.data[0][0]);
  }

  /**
   * Update a node's properties by internal ID
   */
  async updateNode(id: string, props: NodeProperties): Promise<void> {
    const setStatements = Object.entries(props)
      .map(([k, v]) => `n.${k} = ${this.valueToString(v)}`)
      .join(', ');

    const cypher = `MATCH (n) WHERE id(n) = ${id} SET ${setStatements}`;
    await this.query(cypher);
  }

  /**
   * Delete a node by internal ID
   */
  async deleteNode(id: string): Promise<void> {
    const cypher = `MATCH (n) WHERE id(n) = ${id} DELETE n`;
    await this.query(cypher);
  }

  /**
   * Create an edge (relationship) between two nodes
   * Returns the internal relationship ID
   */
  async createEdge(
    fromId: string,
    toId: string,
    type: string,
    props?: NodeProperties
  ): Promise<string> {
    const propsString = props ? ` ${this.propsToString(props)}` : '';
    const cypher = `
      MATCH (a), (b)
      WHERE id(a) = ${fromId} AND id(b) = ${toId}
      CREATE (a)-[r:${type}${propsString}]->(b)
      RETURN id(r) as edgeId
    `;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create edge');
    }

    return String(result.data[0][0]);
  }

  /**
   * Delete an edge by internal ID
   */
  async deleteEdge(id: string): Promise<void> {
    const cypher = `MATCH ()-[r]->() WHERE id(r) = ${id} DELETE r`;
    await this.query(cypher);
  }

  /**
   * Find nodes by type and optional property match
   */
  async findNodes(type: string, match?: NodeProperties): Promise<QueryResult> {
    let whereClause = '';
    if (match && Object.keys(match).length > 0) {
      const conditions = Object.entries(match)
        .map(([k, v]) => `n.${k} = ${this.valueToString(v)}`)
        .join(' AND ');
      whereClause = ` WHERE ${conditions}`;
    }

    const cypher = `MATCH (n:${type})${whereClause} RETURN n`;
    return this.query(cypher);
  }

  private propsToString(props: NodeProperties): string {
    const entries = Object.entries(props)
      .map(([k, v]) => `${k}: ${this.valueToString(v)}`)
      .join(', ');
    return `{${entries}}`;
  }

  private valueToString(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }

  getConnectionStatus(): boolean {
    return this.client?.status === 'ready';
  }

  // ========== Vector Index Methods ==========

  async createVectorIndex(): Promise<void> {
    try {
      await this.query(
        `CREATE VECTOR INDEX FOR (n:StoryNode) ON (n.embedding) OPTIONS {dimension: 1536, similarityFunction: 'cosine'}`
      );
      logger.info('Created vector index on StoryNode.embedding');
    } catch (err: any) {
      if (err?.message?.includes('already exists') || err?.message?.includes('already indexed')) {
        logger.debug('Vector index already exists');
      } else {
        logger.error({ error: err }, 'Failed to create vector index');
        throw err;
      }
    }
  }

  async setNodeEmbedding(nodeId: string, embedding: number[]): Promise<void> {
    const vecString = embedding.join(',');
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      SET n.embedding = vecf32([${vecString}])
    `;
    await this.query(cypher);
  }

  async findSimilarNodes(
    embedding: number[],
    documentId: string,
    userId: string,
    limit: number = 10
  ): Promise<(StoredStoryNode & { score: number })[]> {
    const overFetchLimit = limit * 3;
    const vecString = embedding.join(',');
    const cypher = `
      CALL db.idx.vector.queryNodes('StoryNode', 'embedding', ${overFetchLimit}, vecf32([${vecString}]))
      YIELD node, score
      WHERE node.documentId = '${documentId}' AND node.userId = '${userId}' AND node.deletedAt IS NULL
      RETURN node.id, node.documentId, node.userId, node.type, node.name, node.description,
             node.passages, node.metadata, node.primaryMediaId, node.stylePreset, node.stylePrompt,
             node.narrativeOrder, node.documentOrder,
             node.createdAt, node.updatedAt, node.deletedAt, score
      LIMIT ${limit}
    `;
    const result = await this.query(cypher);

    return result.data.map(row => ({
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      passages: row[6] as string | null,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      narrativeOrder: row[11] as number | null,
      documentOrder: row[12] as number | null,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      deletedAt: row[15] as string | null,
      score: row[16] as number,
    }));
  }

  // ========== StoryNode-Specific Methods ==========

  private getLabelForType(type: StoryNodeType): string {
    switch (type) {
      case 'character': return 'Character';
      case 'location': return 'Location';
      case 'event': return 'Event';
      case 'concept': return 'Concept';
      default: return 'Other';
    }
  }

  async createStoryNode(
    documentId: string,
    userId: string,
    node: StoryNodeResult,
    options?: {
      stylePreset?: string | null;
      stylePrompt?: string | null;
    }
  ): Promise<string> {
    const label = this.getLabelForType(node.type);
    const nodeId = randomUUID();
    const now = new Date().toISOString();

    const props: NodeProperties = {
      id: nodeId,
      documentId,
      userId,
      type: node.type,
      name: node.name,
      description: node.description || null,
      passages: node.passages ? JSON.stringify(node.passages) : null,
      metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      primaryMediaId: null,
      stylePreset: options?.stylePreset ?? null,
      stylePrompt: options?.stylePrompt ?? null,
      narrativeOrder: node.narrativeOrder ?? null,
      documentOrder: node.documentOrder ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const propsString = this.propsToString(props);
    const cypher = `CREATE (n:StoryNode:${label} ${propsString}) RETURN n.id as nodeId`;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create story node');
    }

    logger.info({ nodeId, nodeName: node.name, type: node.type }, 'Story node created in FalkorDB');
    return nodeId;
  }

  async createStoryConnection(
    fromId: string,
    toId: string,
    edgeType: StoryEdgeType,
    description: string | null,
    properties?: { strength?: number; narrativeDistance?: number }
  ): Promise<string> {
    const connectionId = randomUUID();
    const now = new Date().toISOString();

    const props: NodeProperties = {
      id: connectionId,
      description: description ?? null,
      strength: properties?.strength ?? null,
      narrativeDistance: properties?.narrativeDistance ?? null,
      createdAt: now,
      deletedAt: null,
    };

    const propsString = this.propsToString(props);
    const cypher = `
      MATCH (a:StoryNode {id: '${fromId}'}), (b:StoryNode {id: '${toId}'})
      WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
      CREATE (a)-[r:${edgeType} ${propsString}]->(b)
      RETURN r.id as connectionId
    `;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create story connection');
    }

    logger.info({ connectionId, fromId, toId, edgeType }, 'Story connection created in FalkorDB');
    return connectionId;
  }

  async getStoryNodesForDocument(
    documentId: string,
    userId: string
  ): Promise<StoredStoryNode[]> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.documentId = '${documentId}' AND n.userId = '${userId}' AND n.deletedAt IS NULL
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.passages, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.narrativeOrder, n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher);

    return result.data.map(row => ({
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      passages: row[6] as string | null,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      narrativeOrder: row[11] as number | null,
      documentOrder: row[12] as number | null,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      deletedAt: row[15] as string | null,
    }));
  }

  async getStoryConnectionsForDocument(documentId: string): Promise<StoredStoryConnection[]> {
    const cypher = `
      MATCH (a:StoryNode)-[r]->(b:StoryNode)
      WHERE a.documentId = '${documentId}' AND r.deletedAt IS NULL
        AND a.deletedAt IS NULL AND b.deletedAt IS NULL
        AND type(r) <> 'BELONGS_TO_THREAD'
      RETURN r.id, a.id, b.id, type(r) as edgeType, r.description, r.strength, r.narrativeDistance, r.createdAt, r.deletedAt
    `;
    const result = await this.query(cypher);

    return result.data.map(row => ({
      id: row[0] as string,
      fromNodeId: row[1] as string,
      toNodeId: row[2] as string,
      edgeType: row[3] as StoryEdgeType,
      description: row[4] as string | null,
      strength: row[5] as number | null,
      narrativeDistance: row[6] as number | null,
      createdAt: row[7] as string,
      deletedAt: row[8] as string | null,
    }));
  }

  async softDeleteStoryNode(nodeId: string): Promise<void> {
    const now = new Date().toISOString();
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      SET n.deletedAt = '${now}'
    `;
    await this.query(cypher);
    logger.info({ nodeId }, 'Story node soft deleted in FalkorDB');
  }

  async softDeleteStoryConnection(fromId: string, toId: string): Promise<void> {
    const now = new Date().toISOString();
    const cypher = `
      MATCH (a:StoryNode {id: '${fromId}'})-[r]->(b:StoryNode {id: '${toId}'})
      WHERE type(r) <> 'BELONGS_TO_THREAD'
      SET r.deletedAt = '${now}'
    `;
    await this.query(cypher);
    logger.info({ fromId, toId }, 'Story connection soft deleted in FalkorDB');
  }

  async deleteAllStoryNodesForDocument(documentId: string, userId: string): Promise<void> {
    // Also delete narrative threads for this document
    await this.query(`
      MATCH (nt:NarrativeThread)
      WHERE nt.documentId = '${documentId}' AND nt.userId = '${userId}'
      DETACH DELETE nt
    `);
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.documentId = '${documentId}' AND n.userId = '${userId}'
      DETACH DELETE n
    `;
    await this.query(cypher);
    logger.info({ documentId, userId }, 'All story nodes deleted from FalkorDB');
  }

  async updateStoryNode(
    nodeId: string,
    updates: {
      name?: string;
      description?: string;
      passages?: StoryNodePassage[];
    }
  ): Promise<void> {
    const setStatements: string[] = [];
    setStatements.push(`n.updatedAt = '${new Date().toISOString()}'`);

    if (updates.name !== undefined) {
      setStatements.push(`n.name = ${this.valueToString(updates.name)}`);
    }
    if (updates.description !== undefined) {
      setStatements.push(`n.description = ${this.valueToString(updates.description)}`);
    }
    if (updates.passages !== undefined) {
      setStatements.push(`n.passages = ${this.valueToString(JSON.stringify(updates.passages))}`);
    }

    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      SET ${setStatements.join(', ')}
    `;
    await this.query(cypher);
    logger.info({ nodeId }, 'Story node updated in FalkorDB');
  }

  async updateStoryNodePrimaryMedia(nodeId: string, mediaId: string | null): Promise<void> {
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      SET n.primaryMediaId = ${mediaId ? this.valueToString(mediaId) : 'null'},
          n.updatedAt = '${new Date().toISOString()}'
    `;
    await this.query(cypher);
  }

  async updateStoryNodeStyle(
    nodeId: string,
    stylePreset: string | null,
    stylePrompt: string | null
  ): Promise<StoredStoryNode | null> {
    const now = new Date().toISOString();
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      SET n.stylePreset = ${stylePreset ? this.valueToString(stylePreset) : 'null'},
          n.stylePrompt = ${stylePrompt ? this.valueToString(stylePrompt) : 'null'},
          n.updatedAt = '${now}'
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.passages, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.narrativeOrder, n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher);

    if (result.data.length === 0) return null;

    const row = result.data[0];
    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      passages: row[6] as string | null,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      narrativeOrder: row[11] as number | null,
      documentOrder: row[12] as number | null,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      deletedAt: row[15] as string | null,
    };
  }

  async getStoryNodeById(nodeId: string, userId: string): Promise<StoredStoryNode | null> {
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}', userId: '${userId}'})
      WHERE n.deletedAt IS NULL
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.passages, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.narrativeOrder, n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher);

    if (result.data.length === 0) return null;

    const row = result.data[0];
    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      passages: row[6] as string | null,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      narrativeOrder: row[11] as number | null,
      documentOrder: row[12] as number | null,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      deletedAt: row[15] as string | null,
    };
  }

  /**
   * Cleanup soft-deleted nodes and connections older than the given date.
   * Returns count of deleted nodes.
   */
  async cleanupSoftDeleted(beforeDate: Date): Promise<{ nodes: number; connections: number }> {
    const threshold = beforeDate.toISOString();

    const connResult = await this.query(`
      MATCH ()-[r]->()
      WHERE r.deletedAt IS NOT NULL AND r.deletedAt < '${threshold}'
      DELETE r
      RETURN count(r) as deleted
    `);
    const connectionsDeleted = connResult.data[0]?.[0] as number || 0;

    const nodeResult = await this.query(`
      MATCH (n:StoryNode)
      WHERE n.deletedAt IS NOT NULL AND n.deletedAt < '${threshold}'
      DETACH DELETE n
      RETURN count(n) as deleted
    `);
    const nodesDeleted = nodeResult.data[0]?.[0] as number || 0;

    if (nodesDeleted > 0 || connectionsDeleted > 0) {
      logger.info(
        { nodesDeleted, connectionsDeleted, threshold },
        'Cleaned up soft-deleted graph nodes'
      );
    }

    return { nodes: nodesDeleted, connections: connectionsDeleted };
  }

  /**
   * Internal method: get node by ID without user verification.
   * Use only for trusted internal service operations.
   */
  async getStoryNodeByIdInternal(nodeId: string): Promise<StoredStoryNode | null> {
    const cypher = `
      MATCH (n:StoryNode {id: '${nodeId}'})
      WHERE n.deletedAt IS NULL
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.passages, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.narrativeOrder, n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher);

    if (result.data.length === 0) return null;

    const row = result.data[0];
    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      passages: row[6] as string | null,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      narrativeOrder: row[11] as number | null,
      documentOrder: row[12] as number | null,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      deletedAt: row[15] as string | null,
    };
  }

  // ========== Narrative Thread Methods ==========

  async createNarrativeThread(
    documentId: string,
    userId: string,
    thread: NarrativeThreadResult
  ): Promise<string> {
    const threadId = randomUUID();
    const now = new Date().toISOString();

    const props: NodeProperties = {
      id: threadId,
      documentId,
      userId,
      name: thread.name,
      isPrimary: thread.isPrimary,
      createdAt: now,
    };

    const propsString = this.propsToString(props);
    const cypher = `CREATE (nt:NarrativeThread ${propsString}) RETURN nt.id as threadId`;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create narrative thread');
    }

    logger.info({ threadId, name: thread.name }, 'Narrative thread created in FalkorDB');
    return threadId;
  }

  async linkEventToThread(eventId: string, threadId: string, order: number): Promise<void> {
    const cypher = `
      MATCH (e:StoryNode {id: '${eventId}'}), (nt:NarrativeThread {id: '${threadId}'})
      CREATE (e)-[:BELONGS_TO_THREAD {order: ${order}}]->(nt)
    `;
    await this.query(cypher);
  }

  async getNodeSimilaritiesForDocument(
    documentId: string,
    userId: string,
    k: number = 10,
    cutoff: number = 0.3
  ): Promise<{ source: string; target: string; similarity: number }[]> {
    // Single query: pass source.embedding directly to vector index (never leaves FalkorDB)
    const cypher = `
      MATCH (source:StoryNode)
      WHERE source.documentId = '${documentId}' AND source.userId = '${userId}'
        AND source.deletedAt IS NULL AND source.embedding IS NOT NULL
      CALL db.idx.vector.queryNodes('StoryNode', 'embedding', ${k + 1}, source.embedding)
      YIELD node, score
      WHERE node.documentId = '${documentId}' AND node.userId = '${userId}'
        AND node.deletedAt IS NULL AND node.id <> source.id AND score >= ${cutoff}
      RETURN source.id AS sourceId, node.id AS targetId, score
    `;
    const result = await this.query(cypher);

    const similarities: { source: string; target: string; similarity: number }[] = [];
    const seen = new Set<string>();

    for (const row of result.data) {
      const sourceId = row[0] as string;
      const targetId = row[1] as string;
      const score = row[2] as number;

      // Dedupe symmetric pairs (A→B and B→A)
      const pairKey = [sourceId, targetId].sort().join('-');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      similarities.push({
        source: sourceId,
        target: targetId,
        similarity: score,
      });
    }

    return similarities;
  }
}

export const graphService = new GraphService();

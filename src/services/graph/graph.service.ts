import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { THREAD_COLORS } from '../../config/constants';
import type {
  NarrativeThreadResult,
  StoryEdgeType,
  StoryNodeResult,
  StoryNodeType,
} from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import {
  CAUSAL_EDGE_TYPES,
  causalEdgePattern,
  type NodeProperties,
  type QueryResult,
  type StoredStoryConnection,
  type StoredStoryNode,
} from './graph.types';

export type { NodeProperties, StoredStoryNode, StoredStoryConnection, QueryResult };

const GRAPH_NAME = 'gengui';

// Allowed node labels - must be validated before interpolation into queries
const ALLOWED_NODE_LABELS = new Set([
  'StoryNode',
  'Character',
  'Location',
  'Event',
  'Concept',
  'Other',
  'NarrativeThread',
]);

// Allowed edge types - must be validated before interpolation into queries
const ALLOWED_EDGE_TYPES = new Set([
  // Layer 2 (causal/temporal)
  'CAUSES',
  'ENABLES',
  'PREVENTS',
  'HAPPENS_BEFORE',
  // Layer 3 (structural/relational)
  'PARTICIPATES_IN',
  'LOCATED_AT',
  'PART_OF',
  'MEMBER_OF',
  'POSSESSES',
  'CONNECTED_TO',
  'OPPOSES',
  'ABOUT',
  // System
  'BELONGS_TO_THREAD',
  // Fallback
  'RELATED_TO',
]);

// Allowed property names for node queries
const ALLOWED_PROPERTY_NAMES = new Set([
  'id',
  'documentId',
  'userId',
  'type',
  'name',
  'description',
  'aliases',
  'metadata',
  'primaryMediaId',
  'stylePreset',
  'stylePrompt',
  'documentOrder',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'embedding',
  'isPrimary',
  'order',
  'strength',
  'color',
]);

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

      this.client?.once('ready', () => {
        clearTimeout(timeout);
        logger.info('FalkorDB connected');
        resolve();
      });

      this.client?.once('error', (err) => {
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

    const result = (await client.call('GRAPH.QUERY', GRAPH_NAME, queryString)) as unknown[];

    return this.parseResult(result);
  }

  private parseResult(result: unknown[]): QueryResult {
    if (!Array.isArray(result) || result.length < 2) {
      return { headers: [], data: [], stats: {} };
    }

    const headers = Array.isArray(result[0]) ? (result[0] as string[]) : [];
    const data = Array.isArray(result[1]) ? (result[1] as unknown[][]) : [];
    const statsArray = Array.isArray(result[2]) ? (result[2] as string[]) : [];

    const stats: Record<string, string> = {};
    for (const stat of statsArray) {
      const [key, value] = stat.split(':').map((s) => s.trim());
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
    this.validateLabel(type);
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
    const nodeId = this.validateInternalId(id);
    for (const key of Object.keys(props)) {
      this.validatePropertyName(key);
    }
    const setStatements = Object.entries(props)
      .map(([k, v]) => `n.${k} = ${this.valueToString(v)}`)
      .join(', ');

    const cypher = `MATCH (n) WHERE id(n) = $nodeId SET ${setStatements}`;
    await this.query(cypher, { nodeId });
  }

  /**
   * Delete a node by internal ID
   */
  async deleteNode(id: string): Promise<void> {
    const nodeId = this.validateInternalId(id);
    const cypher = `MATCH (n) WHERE id(n) = $nodeId DELETE n`;
    await this.query(cypher, { nodeId });
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
    const fromNodeId = this.validateInternalId(fromId);
    const toNodeId = this.validateInternalId(toId);
    this.validateEdgeType(type);
    if (props) {
      for (const key of Object.keys(props)) {
        this.validatePropertyName(key);
      }
    }
    const propsString = props ? ` ${this.propsToString(props)}` : '';
    const cypher = `
      MATCH (a), (b)
      WHERE id(a) = $fromNodeId AND id(b) = $toNodeId
      CREATE (a)-[r:${type}${propsString}]->(b)
      RETURN id(r) as edgeId
    `;
    const result = await this.query(cypher, { fromNodeId, toNodeId });

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create edge');
    }

    return String(result.data[0][0]);
  }

  /**
   * Delete an edge by internal ID
   */
  async deleteEdge(id: string): Promise<void> {
    const edgeId = this.validateInternalId(id);
    const cypher = `MATCH ()-[r]->() WHERE id(r) = $edgeId DELETE r`;
    await this.query(cypher, { edgeId });
  }

  /**
   * Find nodes by type and optional property match
   */
  async findNodes(type: string, match?: NodeProperties): Promise<QueryResult> {
    this.validateLabel(type);
    let whereClause = '';
    if (match && Object.keys(match).length > 0) {
      for (const key of Object.keys(match)) {
        this.validatePropertyName(key);
      }
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

  // ========== Input Validation Methods ==========

  /**
   * Validate that a label is allowed before interpolating into a query.
   * Labels cannot be parameterized in Cypher, so we must validate against allowlist.
   */
  private validateLabel(label: string): void {
    if (!ALLOWED_NODE_LABELS.has(label)) {
      throw new Error(
        `Invalid node label: ${label}. Allowed: ${[...ALLOWED_NODE_LABELS].join(', ')}`
      );
    }
  }

  /**
   * Validate that an edge type is allowed before interpolating into a query.
   * Edge types cannot be parameterized in Cypher, so we must validate against allowlist.
   */
  private validateEdgeType(edgeType: string): void {
    if (!ALLOWED_EDGE_TYPES.has(edgeType)) {
      throw new Error(
        `Invalid edge type: ${edgeType}. Allowed: ${[...ALLOWED_EDGE_TYPES].join(', ')}`
      );
    }
  }

  /**
   * Validate that a property name is allowed before interpolating into a query.
   * Property names cannot be parameterized in Cypher, so we must validate against allowlist.
   */
  private validatePropertyName(propName: string): void {
    if (!ALLOWED_PROPERTY_NAMES.has(propName)) {
      throw new Error(`Invalid property name: ${propName}`);
    }
  }

  /**
   * Validate and parse an internal FalkorDB node/edge ID.
   * These are integers, not UUIDs.
   */
  private validateInternalId(id: string): number {
    const parsed = parseInt(id, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new Error(`Invalid internal node/edge ID: ${id}`);
    }
    return parsed;
  }

  /**
   * Validate that an embedding is a valid float array of expected dimension.
   */
  private validateEmbedding(embedding: number[], expectedDim: number = 1536): void {
    if (!Array.isArray(embedding)) {
      throw new Error('Embedding must be an array');
    }
    if (embedding.length !== expectedDim) {
      throw new Error(`Embedding must have ${expectedDim} dimensions, got ${embedding.length}`);
    }
    for (let i = 0; i < embedding.length; i++) {
      if (typeof embedding[i] !== 'number' || !Number.isFinite(embedding[i])) {
        throw new Error(`Embedding contains invalid value at index ${i}`);
      }
    }
  }

  getConnectionStatus(): boolean {
    return this.client?.status === 'ready';
  }

  // ========== Acyclicity Validation ==========

  async wouldCreateCycle(fromNodeId: string, toNodeId: string): Promise<boolean> {
    const cypher = `
      MATCH path = (b:StoryNode)-[${causalEdgePattern('*1..50')}]->(a:StoryNode)
      WHERE b.id = $toNodeId AND a.id = $fromNodeId
      RETURN count(path) > 0 AS wouldCycle
      LIMIT 1
    `;
    const result = await this.query(cypher, { toNodeId, fromNodeId });
    if (result.data.length === 0) return false;
    return result.data[0][0] === true || result.data[0][0] === 'true';
  }

  // ========== Query Helper Methods ==========

  /**
   * Generate consistent deletedAt filter clauses.
   * Use these helpers to ensure soft-delete logic is uniform across all queries.
   *
   * @param nodeVar - Node variable name (e.g., 'n', 'a', 'source')
   * @param relVar - Optional relationship variable name (e.g., 'r')
   * @returns Cypher WHERE clause fragment
   */
  private deletedAtFilter(nodeVar: string, relVar?: string): string {
    const nodePart = `${nodeVar}.deletedAt IS NULL`;
    if (relVar) {
      return `${nodePart} AND ${relVar}.deletedAt IS NULL`;
    }
    return nodePart;
  }

  /**
   * Generate deletedAt filter for queries with two nodes and a relationship.
   * Common pattern: MATCH (a)-[r]->(b)
   */
  private deletedAtFilterEdge(fromVar: string, relVar: string, toVar: string): string {
    return `${fromVar}.deletedAt IS NULL AND ${toVar}.deletedAt IS NULL AND ${relVar}.deletedAt IS NULL`;
  }

  // ========== Index Methods ==========

  /**
   * Create property indexes for frequently queried fields.
   * These significantly improve query performance for documentId, userId, deletedAt lookups.
   */
  async createPropertyIndexes(): Promise<void> {
    const indexes = [
      { name: 'documentId', property: 'documentId' },
      { name: 'userId', property: 'userId' },
      { name: 'deletedAt', property: 'deletedAt' },
    ];

    for (const idx of indexes) {
      try {
        await this.query(`CREATE INDEX FOR (n:StoryNode) ON (n.${idx.property})`);
        logger.info({ index: idx.name }, 'Created property index on StoryNode');
      } catch (err: any) {
        if (err?.message?.includes('already exists') || err?.message?.includes('already indexed')) {
          logger.debug({ index: idx.name }, 'Property index already exists');
        } else {
          logger.warn({ error: err, index: idx.name }, 'Failed to create property index');
        }
      }
    }
  }

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

  /**
   * Initialize all indexes (property + vector).
   * Call this once on application startup or after graph initialization.
   */
  async initializeIndexes(): Promise<void> {
    await this.createPropertyIndexes();
    await this.createVectorIndex();
    logger.info('Graph indexes initialized');
  }

  /**
   * Get the execution plan for a query without running it.
   * Use this to verify index usage and debug query performance.
   *
   * @param cypher - The Cypher query to analyze
   * @param params - Optional query parameters
   * @returns The execution plan as a string
   */
  async explainQuery(cypher: string, params?: Record<string, unknown>): Promise<string> {
    const client = await this.ensureConnected();

    let queryString = cypher;
    if (params && Object.keys(params).length > 0) {
      const cypherParams = `CYPHER ${Object.entries(params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')} `;
      queryString = cypherParams + cypher;
    }

    const result = (await client.call('GRAPH.EXPLAIN', GRAPH_NAME, queryString)) as string[];
    return result.join('\n');
  }

  async setNodeEmbedding(nodeId: string, embedding: number[]): Promise<void> {
    this.validateEmbedding(embedding);
    const vecString = embedding.join(',');
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId
      SET n.embedding = vecf32([${vecString}])
    `;
    await this.query(cypher, { nodeId });
  }

  async findSimilarNodes(
    embedding: number[],
    documentId: string,
    userId: string,
    limit: number = 10
  ): Promise<(StoredStoryNode & { score: number })[]> {
    this.validateEmbedding(embedding);
    // Over-fetch to ensure we get enough results after filtering by document/user.
    // FalkorDB vector search has no native filtering, so we fetch extra and filter in WHERE.
    const overFetchLimit = Math.min(limit * 3, 100);
    const vecString = embedding.join(',');
    const cypher = `
      CALL db.idx.vector.queryNodes('StoryNode', 'embedding', ${overFetchLimit}, vecf32([${vecString}]))
      YIELD node, score
      WHERE node.documentId = $documentId AND node.userId = $userId AND node.deletedAt IS NULL
      RETURN node.id, node.documentId, node.userId, node.type, node.name, node.description,
             node.aliases, node.metadata, node.primaryMediaId, node.stylePreset, node.stylePrompt,
             node.documentOrder,
             node.createdAt, node.updatedAt, node.deletedAt, score
      LIMIT $limit
    `;
    const result = await this.query(cypher, { documentId, userId, limit });

    return result.data.map((row) => {
      const aliasesRaw = row[6] as string | null;
      const aliases = aliasesRaw ? JSON.parse(aliasesRaw) : null;

      return {
        id: row[0] as string,
        documentId: row[1] as string,
        userId: row[2] as string,
        type: row[3] as StoryNodeType,
        name: row[4] as string,
        description: row[5] as string | null,
        aliases,
        metadata: row[7] as string | null,
        primaryMediaId: row[8] as string | null,
        stylePreset: row[9] as string | null,
        stylePrompt: row[10] as string | null,
        documentOrder: row[11] as number | null,
        createdAt: row[12] as string,
        updatedAt: row[13] as string,
        deletedAt: row[14] as string | null,
        score: row[15] as number,
      };
    });
  }

  // ========== StoryNode-Specific Methods ==========

  private getLabelForType(type: StoryNodeType): string {
    switch (type) {
      case 'character':
        return 'Character';
      case 'location':
        return 'Location';
      case 'event':
        return 'Event';
      case 'concept':
        return 'Concept';
      default:
        return 'Other';
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
      aliases: node.aliases && node.aliases.length > 0 ? JSON.stringify(node.aliases) : null,
      metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      primaryMediaId: null,
      stylePreset: options?.stylePreset ?? null,
      stylePrompt: options?.stylePrompt ?? null,
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
    properties?: { strength?: number }
  ): Promise<string> {
    this.validateEdgeType(edgeType);

    if (CAUSAL_EDGE_TYPES.includes(edgeType)) {
      const wouldCycle = await this.wouldCreateCycle(fromId, toId);
      if (wouldCycle) {
        throw new Error(
          `Cannot create ${edgeType} edge from ${fromId} to ${toId}: would create a cycle`
        );
      }
    }

    const connectionId = randomUUID();
    const now = new Date().toISOString();

    const props: NodeProperties = {
      id: connectionId,
      description: description ?? null,
      strength: properties?.strength ?? null,
      createdAt: now,
      deletedAt: null,
    };

    const propsString = this.propsToString(props);
    const cypher = `
      MATCH (a:StoryNode), (b:StoryNode)
      WHERE a.id = $fromId AND b.id = $toId
        AND a.deletedAt IS NULL AND b.deletedAt IS NULL
      CREATE (a)-[r:${edgeType} ${propsString}]->(b)
      RETURN r.id as connectionId
    `;
    const result = await this.query(cypher, { fromId, toId });

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create story connection');
    }

    logger.info({ connectionId, fromId, toId, edgeType }, 'Story connection created in FalkorDB');
    return connectionId;
  }

  async getStoryNodesForDocument(documentId: string, userId: string): Promise<StoredStoryNode[]> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId AND ${this.deletedAtFilter('n')}
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.aliases, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher, { documentId, userId });

    return result.data.map((row) => {
      const aliasesRaw = row[6] as string | null;
      const aliases = aliasesRaw ? JSON.parse(aliasesRaw) : null;

      return {
        id: row[0] as string,
        documentId: row[1] as string,
        userId: row[2] as string,
        type: row[3] as StoryNodeType,
        name: row[4] as string,
        description: row[5] as string | null,
        aliases,
        metadata: row[7] as string | null,
        primaryMediaId: row[8] as string | null,
        stylePreset: row[9] as string | null,
        stylePrompt: row[10] as string | null,
        documentOrder: row[11] as number | null,
        createdAt: row[12] as string,
        updatedAt: row[13] as string,
        deletedAt: row[14] as string | null,
      };
    });
  }

  async getStoryConnectionsForDocument(documentId: string): Promise<StoredStoryConnection[]> {
    const cypher = `
      MATCH (a:StoryNode)-[r]->(b:StoryNode)
      WHERE a.documentId = $documentId
        AND ${this.deletedAtFilterEdge('a', 'r', 'b')}
        AND type(r) IN ['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE', 'PARTICIPATES_IN', 'LOCATED_AT', 'PART_OF', 'MEMBER_OF', 'POSSESSES', 'CONNECTED_TO', 'OPPOSES', 'ABOUT', 'RELATED_TO']
      RETURN r.id, a.id, b.id, type(r) as edgeType, r.description, r.strength, r.createdAt, r.deletedAt
    `;
    const result = await this.query(cypher, { documentId });

    return result.data.map((row) => ({
      id: row[0] as string,
      fromNodeId: row[1] as string,
      toNodeId: row[2] as string,
      edgeType: row[3] as StoryEdgeType,
      description: row[4] as string | null,
      strength: row[5] as number | null,
      narrativeDistance: null,
      createdAt: row[6] as string,
      deletedAt: row[7] as string | null,
    }));
  }

  async softDeleteStoryNode(nodeId: string): Promise<void> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId
      SET n.deletedAt = $deletedAt
    `;
    await this.query(cypher, { nodeId, deletedAt: new Date().toISOString() });
    logger.info({ nodeId }, 'Story node soft deleted in FalkorDB');
  }

  async softDeleteStoryConnection(fromId: string, toId: string): Promise<void> {
    const cypher = `
      MATCH (a:StoryNode)-[r]->(b:StoryNode)
      WHERE a.id = $fromId AND b.id = $toId
        AND type(r) <> 'BELONGS_TO_THREAD'
      SET r.deletedAt = $deletedAt
    `;
    await this.query(cypher, { fromId, toId, deletedAt: new Date().toISOString() });
    logger.info({ fromId, toId }, 'Story connection soft deleted in FalkorDB');
  }

  async deleteAllStoryNodesForDocument(documentId: string, userId: string): Promise<void> {
    // Also delete narrative threads for this document
    await this.query(
      `
      MATCH (nt:NarrativeThread)
      WHERE nt.documentId = $documentId AND nt.userId = $userId
      DETACH DELETE nt
      `,
      { documentId, userId }
    );
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId
      DETACH DELETE n
    `;
    await this.query(cypher, { documentId, userId });
    logger.info({ documentId, userId }, 'All story nodes deleted from FalkorDB');
  }

  async updateStoryNode(
    nodeId: string,
    updates: {
      name?: string;
      description?: string | null;
      aliases?: string[];
      documentOrder?: number | null;
    }
  ): Promise<void> {
    const setStatements: string[] = [];
    const params: Record<string, unknown> = { nodeId, updatedAt: new Date().toISOString() };

    setStatements.push(`n.updatedAt = $updatedAt`);

    if (updates.name !== undefined) {
      setStatements.push(`n.name = $name`);
      params.name = updates.name;
    }
    if (updates.description !== undefined) {
      setStatements.push(`n.description = $description`);
      params.description = updates.description;
    }
    if (updates.aliases !== undefined) {
      setStatements.push(`n.aliases = $aliases`);
      params.aliases = updates.aliases.length > 0 ? JSON.stringify(updates.aliases) : null;
    }
    if (updates.documentOrder !== undefined) {
      setStatements.push(`n.documentOrder = $documentOrder`);
      params.documentOrder = updates.documentOrder;
    }

    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId
      SET ${setStatements.join(', ')}
    `;
    await this.query(cypher, params);
    logger.info({ nodeId }, 'Story node updated in FalkorDB');
  }

  async updateStoryNodePrimaryMedia(nodeId: string, mediaId: string | null): Promise<void> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId
      SET n.primaryMediaId = $mediaId,
          n.updatedAt = $updatedAt
    `;
    await this.query(cypher, { nodeId, mediaId, updatedAt: new Date().toISOString() });
  }

  async updateStoryNodeStyle(
    nodeId: string,
    stylePreset: string | null,
    stylePrompt: string | null
  ): Promise<StoredStoryNode | null> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId
      SET n.stylePreset = $stylePreset,
          n.stylePrompt = $stylePrompt,
          n.updatedAt = $updatedAt
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.aliases, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher, {
      nodeId,
      stylePreset,
      stylePrompt,
      updatedAt: new Date().toISOString(),
    });

    if (result.data.length === 0) return null;

    const row = result.data[0];
    const aliasesRaw = row[6] as string | null;
    const aliases = aliasesRaw ? JSON.parse(aliasesRaw) : null;

    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      aliases,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      documentOrder: row[11] as number | null,
      createdAt: row[12] as string,
      updatedAt: row[13] as string,
      deletedAt: row[14] as string | null,
    };
  }

  async getStoryNodeById(nodeId: string, userId: string): Promise<StoredStoryNode | null> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId AND n.userId = $userId AND ${this.deletedAtFilter('n')}
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.aliases, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher, { nodeId, userId });

    if (result.data.length === 0) return null;

    const row = result.data[0];
    const aliasesRaw = row[6] as string | null;
    const aliases = aliasesRaw ? JSON.parse(aliasesRaw) : null;

    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      aliases,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      documentOrder: row[11] as number | null,
      createdAt: row[12] as string,
      updatedAt: row[13] as string,
      deletedAt: row[14] as string | null,
    };
  }

  /**
   * Cleanup soft-deleted nodes and connections older than the given date.
   * Returns count of deleted nodes.
   */
  async cleanupSoftDeleted(beforeDate: Date): Promise<{ nodes: number; connections: number }> {
    const threshold = beforeDate.toISOString();

    const connResult = await this.query(
      `
      MATCH ()-[r]->()
      WHERE r.deletedAt IS NOT NULL AND r.deletedAt < $threshold
      DELETE r
      RETURN count(r) as deleted
      `,
      { threshold }
    );
    const connectionsDeleted = (connResult.data[0]?.[0] as number) || 0;

    const nodeResult = await this.query(
      `
      MATCH (n:StoryNode)
      WHERE n.deletedAt IS NOT NULL AND n.deletedAt < $threshold
      DETACH DELETE n
      RETURN count(n) as deleted
      `,
      { threshold }
    );
    const nodesDeleted = (nodeResult.data[0]?.[0] as number) || 0;

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
      MATCH (n:StoryNode)
      WHERE n.id = $nodeId AND n.deletedAt IS NULL
      RETURN n.id, n.documentId, n.userId, n.type, n.name, n.description,
             n.aliases, n.metadata, n.primaryMediaId, n.stylePreset, n.stylePrompt,
             n.documentOrder,
             n.createdAt, n.updatedAt, n.deletedAt
    `;
    const result = await this.query(cypher, { nodeId });

    if (result.data.length === 0) return null;

    const row = result.data[0];
    const aliasesRaw = row[6] as string | null;
    const aliases = aliasesRaw ? JSON.parse(aliasesRaw) : null;

    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      type: row[3] as StoryNodeType,
      name: row[4] as string,
      description: row[5] as string | null,
      aliases,
      metadata: row[7] as string | null,
      primaryMediaId: row[8] as string | null,
      stylePreset: row[9] as string | null,
      stylePrompt: row[10] as string | null,
      documentOrder: row[11] as number | null,
      createdAt: row[12] as string,
      updatedAt: row[13] as string,
      deletedAt: row[14] as string | null,
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

    // Auto-assign color from Material Design palette
    const { graphThreads } = await import('./graph.threads.js');
    const existingThreads = await graphThreads.getThreadsForDocument(documentId, userId);
    const usedColors = new Set(existingThreads.map((t: any) => t.color).filter(Boolean));

    // Find first unused color, or cycle back to start
    let color = THREAD_COLORS[0];
    for (const c of THREAD_COLORS) {
      if (!usedColors.has(c)) {
        color = c;
        break;
      }
    }

    const props: NodeProperties = {
      id: threadId,
      documentId,
      userId,
      name: thread.name,
      isPrimary: thread.isPrimary,
      color,
      createdAt: now,
    };

    const propsString = this.propsToString(props);
    const cypher = `CREATE (nt:NarrativeThread ${propsString}) RETURN nt.id as threadId`;
    const result = await this.query(cypher);

    if (result.data.length === 0 || result.data[0].length === 0) {
      throw new Error('Failed to create narrative thread');
    }

    logger.info({ threadId, name: thread.name, color }, 'Narrative thread created in FalkorDB');
    return threadId;
  }

  async linkEventToThread(eventId: string, threadId: string, order: number): Promise<void> {
    const cypher = `
      MATCH (e:StoryNode), (nt:NarrativeThread)
      WHERE e.id = $eventId AND nt.id = $threadId
      CREATE (e)-[:BELONGS_TO_THREAD {order: $order}]->(nt)
    `;
    await this.query(cypher, { eventId, threadId, order });
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
      WHERE source.documentId = $documentId AND source.userId = $userId
        AND source.deletedAt IS NULL AND source.embedding IS NOT NULL
      CALL db.idx.vector.queryNodes('StoryNode', 'embedding', ${k + 1}, source.embedding)
      YIELD node, score
      WHERE node.documentId = $documentId AND node.userId = $userId
        AND node.deletedAt IS NULL AND node.id <> source.id AND score >= $cutoff
      RETURN source.id AS sourceId, node.id AS targetId, score
    `;
    const result = await this.query(cypher, { documentId, userId, cutoff });

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

  async getNodeEmbeddingsProjection(
    documentId: string,
    userId: string
  ): Promise<Array<{ nodeId: string; x: number; y: number }>> {
    const cypher = `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId
        AND n.deletedAt IS NULL AND n.embedding IS NOT NULL
      RETURN n.id, n.embedding
    `;
    const result = await this.query(cypher, { documentId, userId });

    if (result.data.length === 0) {
      return [];
    }

    const PCAModule = await import('ml-pca');
    const PCA = (PCAModule as any).default || PCAModule;

    const nodeIds: string[] = [];
    const embeddings: number[][] = [];

    for (const row of result.data) {
      const nodeId = row[0] as string;
      const embeddingRaw = row[1];

      let embedding: number[];
      if (Array.isArray(embeddingRaw)) {
        embedding = embeddingRaw as number[];
      } else if (typeof embeddingRaw === 'string') {
        // FalkorDB returns vector as string like "<-0.024,0.015,...>"
        // Strip < and > and split by comma
        const cleaned = embeddingRaw.replace(/^<|>$/g, '').trim();
        if (!cleaned) {
          logger.warn({ nodeId }, 'Skipping node with empty embedding string');
          continue;
        }
        embedding = cleaned.split(',').map((s) => parseFloat(s.trim()));
      } else {
        logger.warn(
          { nodeId, embeddingType: typeof embeddingRaw },
          'Skipping node with invalid embedding format'
        );
        continue;
      }

      if (embedding.length !== 1536) {
        logger.warn(
          { nodeId, length: embedding.length },
          'Skipping node with wrong embedding dimension'
        );
        continue;
      }

      nodeIds.push(nodeId);
      embeddings.push(embedding);
    }

    if (embeddings.length < 2) {
      logger.info(
        { count: embeddings.length },
        'Not enough embeddings for PCA, returning empty projection'
      );
      return [];
    }

    const pca = new PCA(embeddings);
    const projected = pca.predict(embeddings, { nComponents: 2 });

    const projectedArray = projected.to2DArray();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const point of projectedArray) {
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const VIEWPORT_SIZE = 2000;
    const VIEWPORT_CENTER = 1000;

    const SCALE_FACTOR = 0.8;

    const result_positions: Array<{ nodeId: string; x: number; y: number }> = [];

    for (let i = 0; i < nodeIds.length; i++) {
      const point = projectedArray[i];

      const normalizedX = (point[0] - minX) / rangeX;
      const normalizedY = (point[1] - minY) / rangeY;

      const x = VIEWPORT_CENTER + (normalizedX - 0.5) * VIEWPORT_SIZE * SCALE_FACTOR;
      const y = VIEWPORT_CENTER + (normalizedY - 0.5) * VIEWPORT_SIZE * SCALE_FACTOR;

      result_positions.push({
        nodeId: nodeIds[i],
        x: Math.round(x),
        y: Math.round(y),
      });
    }

    logger.info(
      { documentId, nodeCount: result_positions.length },
      'Generated PCA projection for document'
    );

    return result_positions;
  }
}

export const graphService = new GraphService();

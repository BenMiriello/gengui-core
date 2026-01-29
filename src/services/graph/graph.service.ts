import Redis from 'ioredis';
import { logger } from '../../utils/logger';

export interface NodeProperties {
  [key: string]: string | number | boolean | null;
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
}

export const graphService = new GraphService();

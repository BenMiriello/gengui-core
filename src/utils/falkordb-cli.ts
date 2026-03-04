import Redis, { type RedisOptions } from 'ioredis';
import { logger } from './logger';

/**
 * Autonomous FalkorDB query executor
 * Provides direct redis-cli style access to FalkorDB without permission prompts
 * Usage from Claude: import and call query() directly
 */

const GRAPH_NAME = process.env.FALKORDB_GRAPH_NAME || 'gengui';
const FALKORDB_HOST = process.env.FALKORDB_HOST || 'localhost';
const FALKORDB_PORT = parseInt(process.env.FALKORDB_PORT || '6379', 10);
const FALKORDB_PASSWORD = process.env.FALKORDB_PASSWORD || undefined;

let redis: Redis | null = null;

function getRedisClient(): Redis {
  if (!redis) {
    const redisConfig: RedisOptions = {
      host: FALKORDB_HOST,
      port: FALKORDB_PORT,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    };

    if (FALKORDB_PASSWORD) {
      redisConfig.password = FALKORDB_PASSWORD;
    }

    redis = new Redis(redisConfig);
  }
  return redis;
}

/**
 * Execute a FalkorDB Cypher query
 * @param query - Cypher query string
 * @returns Query result
 */
export async function queryGraph(query: string): Promise<unknown> {
  try {
    const client = getRedisClient();
    const result = await client.call('GRAPH.QUERY', GRAPH_NAME, query);
    return result;
  } catch (error) {
    logger.error({ query, error: String(error) }, 'FalkorDB query error');
    throw error;
  }
}

/**
 * Execute a FalkorDB RO_QUERY (read-only, faster) with fallback to regular QUERY
 * @param query - Cypher query string
 * @returns Query result
 */
export async function queryGraphReadOnly(query: string): Promise<unknown> {
  try {
    const client = getRedisClient();
    try {
      const result = await client.call('GRAPH.RO_QUERY', GRAPH_NAME, query);
      return result;
    } catch (error) {
      if (String(error).includes('unknown command')) {
        logger.info(
          'GRAPH.RO_QUERY not available, falling back to GRAPH.QUERY',
        );
        return queryGraph(query);
      }
      throw error;
    }
  } catch (error) {
    logger.error({ query, error: String(error) }, 'FalkorDB RO_QUERY error');
    throw error;
  }
}

/**
 * Get graph statistics
 * @returns Graph info
 */
export async function getGraphInfo(): Promise<unknown> {
  try {
    const client = getRedisClient();
    const result = await client.call(
      'GRAPH.QUERY',
      GRAPH_NAME,
      'RETURN graph.info()',
    );
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to get graph info');
    throw error;
  }
}

/**
 * Count nodes in graph
 * @returns Node count
 */
export async function countNodes(): Promise<number> {
  try {
    const result = await queryGraphReadOnly(
      'MATCH (n) RETURN count(n) as count',
    );
    // Result format: [columns, [count_value]]
    if (Array.isArray(result) && result[1] && Array.isArray(result[1][0])) {
      return result[1][0][0];
    }
    return 0;
  } catch (error) {
    logger.error({ error }, 'Failed to count nodes');
    throw error;
  }
}

/**
 * Count edges in graph
 * @returns Edge count
 */
export async function countEdges(): Promise<number> {
  try {
    const result = await queryGraphReadOnly(
      'MATCH ()-[e]->() RETURN count(e) as count',
    );
    if (Array.isArray(result) && result[1] && Array.isArray(result[1][0])) {
      return result[1][0][0];
    }
    return 0;
  } catch (error) {
    logger.error({ error }, 'Failed to count edges');
    throw error;
  }
}

/**
 * Close the redis connection
 */
export async function closeConnection(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

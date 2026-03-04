/**
 * FalkorDB Query Utilities
 *
 * Simple wrapper around redis-cli for FalkorDB graph queries.
 * Use this instead of raw redis-cli calls for consistency.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const FALKORDB_PORT = process.env.FALKORDB_PORT || '6381';
const FALKORDB_HOST = process.env.FALKORDB_HOST || 'localhost';

/**
 * Execute a Cypher query on the gengui graph
 */
export async function queryGraph(cypher: string): Promise<string> {
  const { stdout } = await execAsync(
    `redis-cli -h ${FALKORDB_HOST} -p ${FALKORDB_PORT} GRAPH.QUERY gengui "${cypher.replace(/"/g, '\\"')}"`,
  );
  return stdout.trim();
}

/**
 * Quick count of nodes matching pattern
 */
export async function countNodes(pattern?: string): Promise<number> {
  const whereClause = pattern ? `WHERE ${pattern}` : '';
  const result = await queryGraph(`MATCH (n) ${whereClause} RETURN count(n)`);
  const match = result.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Quick count of edges by type
 */
export async function countEdges(edgeType?: string): Promise<number> {
  const typePattern = edgeType ? `:${edgeType}` : '';
  const result = await queryGraph(
    `MATCH ()-[r${typePattern}]->() RETURN count(r)`,
  );
  const match = result.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Get schema info
 */
export async function getSchemaInfo(): Promise<{
  labels: string[];
  relationshipTypes: string[];
  propertyKeys: string[];
}> {
  const labels = await queryGraph('CALL db.labels()');
  const relationships = await queryGraph('CALL db.relationshipTypes()');
  const properties = await queryGraph('CALL db.propertyKeys()');

  return {
    labels: parseSchemaResult(labels),
    relationshipTypes: parseSchemaResult(relationships),
    propertyKeys: parseSchemaResult(properties),
  };
}

function parseSchemaResult(output: string): string[] {
  const lines = output.split('\n');
  return lines
    .filter((line) => line.trim() && !line.includes('Cached execution'))
    .map((line) => line.trim());
}

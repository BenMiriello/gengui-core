import Redis from 'ioredis';

let graphClient: Redis | null = null;

const GRAPH_NAME = process.env.FALKORDB_GRAPH_NAME || 'gengui_test';

function getConnectionUrl(): string {
  return process.env.FALKORDB_URL || 'redis://localhost:6381';
}

export async function connectGraph(): Promise<void> {
  if (graphClient?.status === 'ready') {
    return;
  }

  graphClient = new Redis(getConnectionUrl(), {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 100, 1000);
    },
    lazyConnect: true,
  });

  await graphClient.connect();
}

export async function clearGraphData(): Promise<void> {
  if (!graphClient) {
    throw new Error('Graph client not connected. Call connectGraph() first.');
  }

  await graphClient.call('GRAPH.QUERY', GRAPH_NAME, 'MATCH (n) DETACH DELETE n');
}

export async function closeGraph(): Promise<void> {
  if (graphClient) {
    await graphClient.quit();
    graphClient = null;
  }
}

export function getGraphClient(): Redis | null {
  return graphClient;
}

export async function graphQuery(cypher: string): Promise<unknown> {
  if (!graphClient) {
    throw new Error('Graph client not connected. Call connectGraph() first.');
  }

  return graphClient.call('GRAPH.QUERY', GRAPH_NAME, cypher);
}

# FalkorDB Query Utility

This module provides a simple, autonomous interface for querying FalkorDB (the knowledge graph layer) without permission prompts or interactive CLI interference.

## Files

- `falkordb-cli.ts` - **Use this file** for all FalkorDB queries. Provides ioredis-based autonomous access.
- `falkordb-query.ts` - Legacy shell-based utility (uses redis-cli). Kept for reference only.

## Usage

### Import and Use

```typescript
import {
  queryGraph,
  queryGraphReadOnly,
  countNodes,
  countEdges,
  getGraphInfo,
  closeConnection,
} from '../utils/falkordb-cli';

// Basic Cypher query
const result = await queryGraph('MATCH (n:Entity) RETURN n LIMIT 5');

// Read-only query (faster, with fallback)
const readResult = await queryGraphReadOnly('MATCH (n) RETURN count(n) as count');

// Quick utilities
const nodeCount = await countNodes();
const edgeCount = await countEdges();
const info = await getGraphInfo();

// Clean up when done
await closeConnection();
```

### Export from Utils Index

The utility is exported from `/core/src/utils/index.ts`, so you can also import directly from utils:

```typescript
import { queryGraph, countNodes, countEdges } from '../utils';
```

## Configuration

Required environment variables (typically in `.env.secrets`):

```bash
FALKORDB_HOST=<hostname>          # Default: localhost
FALKORDB_PORT=<port>              # Default: 6379
FALKORDB_PASSWORD=<password>      # Optional, for authentication
FALKORDB_GRAPH_NAME=<name>        # Default: gengui
```

## API Reference

### `queryGraph(cypher: string): Promise<unknown>`
Execute a Cypher query for write operations. Automatically creates connection if needed.

### `queryGraphReadOnly(cypher: string): Promise<unknown>`
Execute a read-only query. Tries `GRAPH.RO_QUERY` first for performance, falls back to `GRAPH.QUERY` if unavailable.

### `countNodes(): Promise<number>`
Returns the total count of nodes in the graph.

### `countEdges(): Promise<number>`
Returns the total count of edges in the graph.

### `getGraphInfo(): Promise<unknown>`
Returns graph statistics and metadata.

### `closeConnection(): Promise<void>`
Closes the Redis connection. Call this when done with queries.

## Autonomous Operation

- **No prompts**: Uses ioredis library instead of shell execution, so no permission prompts appear.
- **No process spawning**: Direct Redis protocol communication avoids interactive shell issues.
- **Error handling**: Graceful fallback for older FalkorDB versions that don't support RO_QUERY.
- **Connection pooling**: Reuses a single Redis client for efficiency.

## Testing

Run the test script to verify the utility is working:

```bash
bun src/scripts/test-falkordb.ts
```

This will:
1. Verify FalkorDB connection
2. Test node/edge counting
3. Run a sample Cypher query
4. Display graph info

## Related Files

- **Graph Service**: `/core/src/services/graph/graph.service.ts` - Main application using FalkorDB
- **Graph Types**: `/core/src/services/graph/graph.types.ts` - Type definitions for graph queries
- **Graph Tests**: `/core/src/__tests__/helpers/graphSetup.ts` - Test setup for graph operations

## Notes

- The utility automatically manages connection lifecycle through ioredis pooling.
- For local development without FalkorDB, you can mock the functions or run against a remote instance via environment variables.
- All queries use the graph name from `FALKORDB_GRAPH_NAME` (default: "gengui").

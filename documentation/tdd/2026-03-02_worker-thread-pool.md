# TDD: Worker Thread Pool for CPU-Bound Operations

## Problem

CPU-bound operations in the analysis pipeline block the Node.js event loop, preventing HTTP requests, SSE connections, and health checks from being handled during large document analysis.

**Affected operations:**
- `findMergeCandidates`: O(n²) cosine similarity across entities
- `clusterEntities`: Similarity matrix computation in entity resolution
- `buildEntityRegistryForPrompt`: Sorting by embedding similarity

**Symptoms:**
- `/health` endpoint unresponsive during analysis
- SSE connections drop
- Other users' requests timeout

## Solution

Use Piscina worker thread pool to offload CPU-bound work. Main thread orchestrates I/O (API calls, DB, Redis), workers handle computation.

## Architecture

```
Main Thread                          Worker Pool (Piscina)
─────────────────                    ────────────────────
TextAnalysisConsumer                 Worker 1 ─┐
     │                               Worker 2  ├─ CPU tasks
multiStagePipeline.run()             Worker 3  │
     │                               Worker 4 ─┘
     ├─ Stage 1-3: I/O (main)
     │    └─ LLM calls, DB, embeddings API
     │
     ├─ Stage 4: Entity Resolution
     │    └─ cpuPool.run('clusterEntities', data) ──► Worker
     │
     ├─ Stage 4.5: Merge Review
     │    └─ cpuPool.run('findMergeCandidates', data) ──► Worker
     │
     └─ Stage 5-9: I/O (main)
```

## Files

### New Files

**`src/lib/cpu-pool.ts`** - Pool singleton and typed interface
```typescript
import Piscina from 'piscina';
import { cpus } from 'os';
import { resolve } from 'path';

const pool = new Piscina({
  filename: resolve(__dirname, '../workers/cpu.worker.js'),
  minThreads: 1,
  maxThreads: Math.max(2, cpus().length - 1),
  idleTimeout: 60000,
});

export interface SimilarityCandidate {
  index1: number;
  index2: number;
  similarity: number;
}

export interface ClusterResult {
  clusters: number[][];
  mergedIndices: Set<number>;
}

export const cpuPool = {
  findMergeCandidates(
    embeddings: number[][],
    types: string[],
    threshold: number
  ): Promise<SimilarityCandidate[]> {
    return pool.run({ embeddings, types, threshold }, { name: 'findMergeCandidates' });
  },

  computeSimilarityMatrix(
    embeddings: number[][],
    types: string[]
  ): Promise<number[][]> {
    return pool.run({ embeddings, types }, { name: 'computeSimilarityMatrix' });
  },

  async shutdown(): Promise<void> {
    await pool.destroy();
  },
};
```

**`src/workers/cpu.worker.ts`** - Worker implementation
```typescript
// Pure functions only - no imports from main app (no DB, no services)

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function findMergeCandidates(
  { embeddings, types, threshold }: { embeddings: number[][]; types: string[]; threshold: number }
): { index1: number; index2: number; similarity: number }[] {
  const candidates = [];
  for (let i = 0; i < embeddings.length; i++) {
    if (!embeddings[i]) continue;
    for (let j = i + 1; j < embeddings.length; j++) {
      if (!embeddings[j]) continue;
      if (types[i] !== types[j]) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= threshold) {
        candidates.push({ index1: i, index2: j, similarity: sim });
      }
    }
  }
  return candidates.sort((a, b) => b.similarity - a.similarity);
}

export function computeSimilarityMatrix(
  { embeddings, types }: { embeddings: number[][]; types: string[] }
): number[][] {
  const n = embeddings.length;
  const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    if (!embeddings[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!embeddings[j] || types[i] !== types[j]) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }
  return matrix;
}
```

### Modified Files

**`src/services/pipeline/mergeReview.ts`**
- Replace direct `findMergeCandidates` loop with `cpuPool.findMergeCandidates()`
- Extract embeddings/types arrays from entities, pass to worker
- Map results back to entity objects

**`src/services/entityResolution/clustering.ts`**
- Replace inline similarity computation with `cpuPool.computeSimilarityMatrix()`
- Keep cluster algorithm on main thread (uses results, not CPU-heavy)

**`src/index.ts`**
- Add graceful shutdown: `cpuPool.shutdown()` before process exit

## Data Serialization

Workers communicate via structured clone. Constraints:
- No functions, classes, or circular references
- Embeddings (number[][]) serialize efficiently
- Entity objects must be flattened to primitives before sending

**Pattern:**
```typescript
// Before calling worker
const embeddings = entities.map(e => e.embedding);
const types = entities.map(e => e.type);

// Call worker with primitives
const candidates = await cpuPool.findMergeCandidates(embeddings, types, 0.85);

// Map results back
const result = candidates.map(c => ({
  entity1: entities[c.index1],
  entity2: entities[c.index2],
  similarity: c.similarity,
}));
```

## Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| `minThreads` | 1 | Keep one warm for responsiveness |
| `maxThreads` | `cpus().length - 1` | Leave one core for main thread |
| `idleTimeout` | 60000ms | Kill idle workers after 1 min |

## Graceful Shutdown

```typescript
// src/index.ts
process.on('SIGTERM', async () => {
  await cpuPool.shutdown();
  // ... existing shutdown
});
```

## Testing

**Unit tests (`src/__tests__/workers/cpu.worker.test.ts`):**
- `findMergeCandidates` returns correct pairs above threshold
- `findMergeCandidates` skips different types
- `computeSimilarityMatrix` is symmetric
- Empty input returns empty result

**Integration test:**
- Verify main thread remains responsive during worker execution
- Start analysis, immediately call `/health`, assert 200

## Rollout

1. Add `piscina` dependency
2. Implement worker file + pool wrapper
3. Update `mergeReview.ts` to use pool
4. Update `clustering.ts` to use pool
5. Add shutdown hook
6. Test with large document (Dracula)
7. Monitor: worker utilization, queue depth, response times

## Future Extensions

- Add more CPU-bound operations as identified
- Metrics export (Piscina exposes queue stats)
- Separate pool for different task types if needed

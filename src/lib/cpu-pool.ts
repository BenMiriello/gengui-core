/**
 * CPU Worker Thread Pool
 *
 * Singleton Piscina pool for offloading CPU-bound operations (O(n²) similarity).
 * Keeps event loop responsive during heavy computation.
 */

import { cpus } from 'node:os';
import { resolve } from 'node:path';
import Piscina from 'piscina';
import { logger } from '../utils/logger';

export interface SimilarityCandidate {
  index1: number;
  index2: number;
  similarity: number;
}

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: resolve(__dirname, '../workers/cpu.worker.ts'),
      minThreads: 1,
      maxThreads: Math.max(2, cpus().length - 1),
      idleTimeout: 60000,
    });
    logger.info(
      { minThreads: 1, maxThreads: Math.max(2, cpus().length - 1) },
      'CPU worker pool initialized',
    );
  }
  return pool;
}

export const cpuPool = {
  async findMergeCandidates(
    embeddings: (number[] | null)[],
    types: string[],
    threshold: number,
  ): Promise<SimilarityCandidate[]> {
    return getPool().run(
      { embeddings, types, threshold },
      { name: 'findMergeCandidates' },
    );
  },

  async computeSimilarityMatrix(
    embeddings: (number[] | null)[],
    types: string[],
  ): Promise<number[][]> {
    return getPool().run(
      { embeddings, types },
      { name: 'computeSimilarityMatrix' },
    );
  },

  async shutdown(): Promise<void> {
    if (pool) {
      logger.info('Shutting down CPU worker pool');
      await pool.destroy();
      pool = null;
    }
  },
};

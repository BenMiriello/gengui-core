import { describe, expect, test } from 'bun:test';
import {
  computeSimilarityMatrix,
  findMergeCandidates,
} from '../../workers/cpu.worker';

describe('cpu.worker', () => {
  describe('findMergeCandidates', () => {
    test('returns empty array for empty input', () => {
      const result = findMergeCandidates({
        embeddings: [],
        types: [],
        threshold: 0.85,
      });
      expect(result).toEqual([]);
    });

    test('returns empty array when no embeddings meet threshold', () => {
      const result = findMergeCandidates({
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        types: ['person', 'person', 'person'],
        threshold: 0.85,
      });
      expect(result).toEqual([]);
    });

    test('finds similar pairs above threshold', () => {
      const result = findMergeCandidates({
        embeddings: [
          [1, 0, 0],
          [0.99, 0.1, 0],
          [0, 1, 0],
        ],
        types: ['person', 'person', 'person'],
        threshold: 0.85,
      });
      expect(result.length).toBe(1);
      expect(result[0].index1).toBe(0);
      expect(result[0].index2).toBe(1);
      expect(result[0].similarity).toBeGreaterThan(0.85);
    });

    test('filters by type (different types not paired)', () => {
      const result = findMergeCandidates({
        embeddings: [
          [1, 0, 0],
          [1, 0, 0],
        ],
        types: ['person', 'place'],
        threshold: 0.5,
      });
      expect(result).toEqual([]);
    });

    test('handles null embeddings', () => {
      const result = findMergeCandidates({
        embeddings: [[1, 0, 0], null, [1, 0, 0]],
        types: ['person', 'person', 'person'],
        threshold: 0.5,
      });
      expect(result.length).toBe(1);
      expect(result[0].index1).toBe(0);
      expect(result[0].index2).toBe(2);
    });

    test('returns results sorted by similarity descending', () => {
      const result = findMergeCandidates({
        embeddings: [
          [1, 0, 0],
          [0.9, 0.1, 0],
          [0.99, 0.01, 0],
        ],
        types: ['person', 'person', 'person'],
        threshold: 0.8,
      });
      // With embeddings [1,0,0], [0.9,0.1,0], [0.99,0.01,0] and threshold 0.8:
      // - Pair (0,1): similarity ~0.90 > 0.8
      // - Pair (0,2): similarity ~0.99 > 0.8
      // - Pair (1,2): similarity ~0.89 > 0.8
      // All 3 pairs exceed threshold
      expect(result.length).toBe(3);
      expect(result[0].similarity).toBeGreaterThan(result[1].similarity);
    });
  });

  describe('computeSimilarityMatrix', () => {
    test('returns identity matrix for empty input', () => {
      const result = computeSimilarityMatrix({
        embeddings: [],
        types: [],
      });
      expect(result).toEqual([]);
    });

    test('diagonal is always 1', () => {
      const result = computeSimilarityMatrix({
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        types: ['person', 'person', 'person'],
      });
      expect(result[0][0]).toBe(1);
      expect(result[1][1]).toBe(1);
      expect(result[2][2]).toBe(1);
    });

    test('matrix is symmetric', () => {
      const result = computeSimilarityMatrix({
        embeddings: [
          [1, 0, 0],
          [0.5, 0.5, 0],
          [0, 0, 1],
        ],
        types: ['person', 'person', 'person'],
      });
      expect(result[0][1]).toBe(result[1][0]);
      expect(result[0][2]).toBe(result[2][0]);
      expect(result[1][2]).toBe(result[2][1]);
    });

    test('different types have 0 similarity', () => {
      const result = computeSimilarityMatrix({
        embeddings: [
          [1, 0, 0],
          [1, 0, 0],
        ],
        types: ['person', 'place'],
      });
      expect(result[0][1]).toBe(0);
      expect(result[1][0]).toBe(0);
    });

    test('handles null embeddings', () => {
      const result = computeSimilarityMatrix({
        embeddings: [[1, 0, 0], null, [1, 0, 0]],
        types: ['person', 'person', 'person'],
      });
      expect(result[0][1]).toBe(0);
      expect(result[1][0]).toBe(0);
      expect(result[0][2]).toBe(1);
    });
  });
});

/**
 * CPU Worker Thread
 *
 * Pure functions for CPU-bound operations. Runs in worker threads via Piscina.
 * NO app imports (DB, services, logger) - must be serialization-safe.
 */

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface FindCandidatesInput {
  embeddings: (number[] | null)[];
  types: string[];
  threshold: number;
}

interface SimilarityCandidate {
  index1: number;
  index2: number;
  similarity: number;
}

export function findMergeCandidates(
  input: FindCandidatesInput,
): SimilarityCandidate[] {
  const { embeddings, types, threshold } = input;
  const candidates: SimilarityCandidate[] = [];

  for (let i = 0; i < embeddings.length; i++) {
    const emb1 = embeddings[i];
    if (!emb1) continue;

    for (let j = i + 1; j < embeddings.length; j++) {
      const emb2 = embeddings[j];
      if (!emb2 || types[i] !== types[j]) continue;

      const similarity = cosineSimilarity(emb1, emb2);
      if (similarity >= threshold) {
        candidates.push({ index1: i, index2: j, similarity });
      }
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

interface ComputeMatrixInput {
  embeddings: (number[] | null)[];
  types: string[];
}

export function computeSimilarityMatrix(input: ComputeMatrixInput): number[][] {
  const { embeddings, types } = input;
  const n = embeddings.length;
  const matrix: number[][] = Array(n)
    .fill(null)
    .map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    const emb1 = embeddings[i];
    if (!emb1) continue;

    for (let j = i + 1; j < n; j++) {
      const emb2 = embeddings[j];
      if (!emb2 || types[i] !== types[j]) continue;

      const sim = cosineSimilarity(emb1, emb2);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }

  return matrix;
}

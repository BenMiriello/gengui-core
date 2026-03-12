/**
 * Sentence embedding service.
 * Handles sentence extraction, embedding generation, and similarity search.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { sentenceEmbeddings } from '../../models/schema';
import { logger } from '../../utils/logger';
import { generateEmbedding, generateEmbeddings } from '../embeddings';
import type { Segment } from '../segments';
import { splitIntoSentences } from './sentence.detector';
import type {
  Sentence,
  SentenceSimilarityResult,
  SentenceWithEmbedding,
  StoredSentenceEmbedding,
} from './sentence.types';

export const sentenceService = {
  /**
   * Extract sentences from a segment's text.
   */
  extractSentences(segmentText: string): Sentence[] {
    return splitIntoSentences(segmentText);
  },

  /**
   * Process a segment: extract sentences and generate/cache embeddings.
   * Returns sentences with embeddings.
   */
  async processSegment(
    documentId: string,
    segmentId: string,
    segmentText: string,
  ): Promise<SentenceWithEmbedding[]> {
    const sentences = this.extractSentences(segmentText);

    if (sentences.length === 0) {
      return [];
    }

    // Check cache for existing embeddings
    const contentHashes = sentences.map((s) => s.contentHash);
    const cached = await this.getCachedByHashes(contentHashes);
    const cachedMap = new Map(cached.map((c) => [c.contentHash, c.embedding]));

    const results: SentenceWithEmbedding[] = [];
    const toEmbed: Sentence[] = [];

    for (const sentence of sentences) {
      const cachedEmbedding = cachedMap.get(sentence.contentHash);
      if (cachedEmbedding) {
        results.push({ ...sentence, embedding: cachedEmbedding });
      } else {
        toEmbed.push(sentence);
      }
    }

    // Generate embeddings for uncached sentences
    if (toEmbed.length > 0) {
      const embeddings = await this.generateBatchEmbeddings(
        toEmbed.map((s) => s.text),
      );

      for (let i = 0; i < toEmbed.length; i++) {
        const sentence = toEmbed[i];
        const embedding = embeddings[i];

        results.push({ ...sentence, embedding });

        // Store in database
        await this.store(documentId, segmentId, sentence, embedding);
      }
    }

    // Sort by start position
    results.sort((a, b) => a.start - b.start);
    return results;
  },

  /**
   * Process all segments of a document.
   * Returns map of segmentId -> sentences with embeddings.
   * Processes segments in parallel with limited concurrency.
   */
  async processDocument(
    documentId: string,
    documentContent: string,
    segments: Segment[],
  ): Promise<Map<string, SentenceWithEmbedding[]>> {
    const { default: pMap } = await import('p-map');
    const result = new Map<string, SentenceWithEmbedding[]>();

    await pMap(
      segments,
      async (segment) => {
        const segmentText = documentContent.slice(segment.start, segment.end);
        const sentences = await this.processSegment(
          documentId,
          segment.id,
          segmentText,
        );
        result.set(segment.id, sentences);
      },
      { concurrency: 3 },
    );

    return result;
  },

  /**
   * Store a sentence embedding.
   */
  async store(
    documentId: string,
    segmentId: string,
    sentence: Sentence,
    embedding: number[],
  ): Promise<void> {
    try {
      const embeddingStr = `[${embedding.join(',')}]`;
      await db.execute(sql`
        INSERT INTO sentence_embeddings
          (document_id, segment_id, sentence_start, sentence_end, content_hash, embedding)
        VALUES
          (${documentId}, ${segmentId}, ${sentence.start}, ${sentence.end}, ${sentence.contentHash}, ${embeddingStr}::vector)
      `);
    } catch (err) {
      logger.warn(
        { documentId, segmentId, error: err },
        'Failed to store sentence embedding',
      );
    }
  },

  /**
   * Get cached embeddings by content hashes.
   */
  async getCachedByHashes(
    hashes: string[],
  ): Promise<Array<{ contentHash: string; embedding: number[] }>> {
    if (hashes.length === 0) return [];

    const rows = await db.execute(sql`
      SELECT DISTINCT
        content_hash,
        embedding::text as embedding_text
      FROM sentence_embeddings
      WHERE content_hash IN (${sql.join(
        hashes.map((h) => sql`${h}`),
        sql`, `,
      )})
    `);

    return (rows as { content_hash: string; embedding_text: string }[]).map(
      (row) => ({
        contentHash: row.content_hash,
        embedding: JSON.parse(row.embedding_text),
      }),
    );
  },

  /**
   * Get all sentence embeddings for a document.
   */
  async getByDocumentId(
    documentId: string,
  ): Promise<StoredSentenceEmbedding[]> {
    const rows = await db.execute(sql`
      SELECT
        id,
        document_id,
        segment_id,
        sentence_start,
        sentence_end,
        content_hash,
        embedding::text as embedding_text,
        created_at,
        updated_at
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
    `);

    return (
      rows as unknown as Parameters<typeof rowToStoredSentenceFromRaw>[0][]
    ).map(rowToStoredSentenceFromRaw);
  },

  /**
   * Get sentence embeddings for specific segments.
   */
  async getBySegmentIds(
    documentId: string,
    segmentIds: string[],
  ): Promise<StoredSentenceEmbedding[]> {
    if (segmentIds.length === 0) return [];

    const rows = await db.execute(sql`
      SELECT
        id,
        document_id,
        segment_id,
        sentence_start,
        sentence_end,
        content_hash,
        embedding::text as embedding_text,
        created_at,
        updated_at
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
        AND segment_id IN (${sql.join(
          segmentIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    `);

    return (
      rows as unknown as Parameters<typeof rowToStoredSentenceFromRaw>[0][]
    ).map(rowToStoredSentenceFromRaw);
  },

  /**
   * Find sentences similar to a query embedding.
   * Uses cosine similarity via pgvector.
   */
  async findSimilar(
    documentId: string,
    queryEmbedding: number[],
    limit: number = 10,
  ): Promise<SentenceSimilarityResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const rows = await db.execute(sql`
      SELECT
        id,
        segment_id,
        sentence_start,
        sentence_end,
        1 - (embedding <=> ${embeddingStr}::vector) as score
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);

    return (
      rows as unknown as {
        id: string;
        segment_id: string | null;
        sentence_start: number;
        sentence_end: number;
        score: number;
      }[]
    ).map((row) => ({
      sentenceId: row.id,
      segmentId: row.segment_id ?? '',
      sentenceStart: row.sentence_start,
      sentenceEnd: row.sentence_end,
      score: row.score,
    }));
  },

  /**
   * Find sentences similar to text.
   * Generates embedding for the query text first.
   */
  async findSimilarToText(
    documentId: string,
    queryText: string,
    limit: number = 10,
  ): Promise<SentenceSimilarityResult[]> {
    const queryEmbedding = await generateEmbedding(queryText);
    return this.findSimilar(documentId, queryEmbedding, limit);
  },

  /**
   * Delete all sentence embeddings for a document.
   */
  async deleteByDocumentId(documentId: string): Promise<void> {
    await db
      .delete(sentenceEmbeddings)
      .where(eq(sentenceEmbeddings.documentId, documentId));
  },

  /**
   * Delete sentence embeddings for specific segments.
   */
  async deleteBySegmentIds(
    documentId: string,
    segmentIds: string[],
  ): Promise<void> {
    if (segmentIds.length === 0) return;

    await db
      .delete(sentenceEmbeddings)
      .where(
        and(
          eq(sentenceEmbeddings.documentId, documentId),
          inArray(sentenceEmbeddings.segmentId, segmentIds),
        ),
      );
  },

  /**
   * Generate embeddings for multiple texts in batch.
   * Uses batch API with event loop yields between batches to prevent blocking.
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await generateEmbeddings(batch);
      results.push(...embeddings);

      if (i + BATCH_SIZE < texts.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return results;
  },

  /**
   * Compute average embedding for a set of sentence embeddings.
   * Used for representing a segment's semantic content.
   */
  computeAverageEmbedding(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      throw new Error('Cannot compute average of zero embeddings');
    }

    const dim = embeddings[0].length;
    const result = new Array(dim).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < dim; i++) {
        result[i] += embedding[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      result[i] /= embeddings.length;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += result[i] * result[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        result[i] /= norm;
      }
    }

    return result;
  },
};

// @ts-expect-error - Reserved for future use
function _rowToStoredSentence(
  row: typeof sentenceEmbeddings.$inferSelect,
): StoredSentenceEmbedding {
  return {
    id: row.id,
    documentId: row.documentId,
    segmentId: row.segmentId,
    sentenceStart: row.sentenceStart,
    sentenceEnd: row.sentenceEnd,
    contentHash: row.contentHash,
    embedding:
      typeof row.embedding === 'string'
        ? JSON.parse(row.embedding)
        : row.embedding,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToStoredSentenceFromRaw(row: {
  id: string;
  document_id: string;
  segment_id: string | null;
  sentence_start: number;
  sentence_end: number;
  content_hash: string;
  embedding_text: string;
  created_at: Date;
  updated_at: Date;
}): StoredSentenceEmbedding {
  return {
    id: row.id,
    documentId: row.document_id,
    segmentId: row.segment_id,
    sentenceStart: row.sentence_start,
    sentenceEnd: row.sentence_end,
    contentHash: row.content_hash,
    embedding: JSON.parse(row.embedding_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

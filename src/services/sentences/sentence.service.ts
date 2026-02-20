/**
 * Sentence embedding service.
 * Handles sentence extraction, embedding generation, and similarity search.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { sentenceEmbeddings } from '../../models/schema';
import type { Segment } from '../segments';
import { generateEmbedding } from '../embeddings';
import { logger } from '../../utils/logger';
import { splitIntoSentences } from './sentence.detector';
import type {
  Sentence,
  SentenceWithEmbedding,
  StoredSentenceEmbedding,
  SentenceSimilarityResult,
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
    segmentText: string
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
      const embeddings = await this.generateBatchEmbeddings(toEmbed.map((s) => s.text));

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
   */
  async processDocument(
    documentId: string,
    documentContent: string,
    segments: Segment[]
  ): Promise<Map<string, SentenceWithEmbedding[]>> {
    const result = new Map<string, SentenceWithEmbedding[]>();

    for (const segment of segments) {
      const segmentText = documentContent.slice(segment.start, segment.end);
      const sentences = await this.processSegment(documentId, segment.id, segmentText);
      result.set(segment.id, sentences);
    }

    return result;
  },

  /**
   * Store a sentence embedding.
   */
  async store(
    documentId: string,
    segmentId: string,
    sentence: Sentence,
    embedding: number[]
  ): Promise<void> {
    try {
      await db.insert(sentenceEmbeddings).values({
        documentId,
        segmentId,
        sentenceStart: sentence.start,
        sentenceEnd: sentence.end,
        contentHash: sentence.contentHash,
        embedding: JSON.stringify(embedding),
      });
    } catch (err) {
      logger.warn({ documentId, segmentId, error: err }, 'Failed to store sentence embedding');
    }
  },

  /**
   * Get cached embeddings by content hashes.
   */
  async getCachedByHashes(
    hashes: string[]
  ): Promise<Array<{ contentHash: string; embedding: number[] }>> {
    if (hashes.length === 0) return [];

    const rows = await db
      .selectDistinct({
        contentHash: sentenceEmbeddings.contentHash,
        embedding: sentenceEmbeddings.embedding,
      })
      .from(sentenceEmbeddings)
      .where(inArray(sentenceEmbeddings.contentHash, hashes));

    return rows.map((row) => ({
      contentHash: row.contentHash,
      embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    }));
  },

  /**
   * Get all sentence embeddings for a document.
   */
  async getByDocumentId(documentId: string): Promise<StoredSentenceEmbedding[]> {
    const rows = await db
      .select()
      .from(sentenceEmbeddings)
      .where(eq(sentenceEmbeddings.documentId, documentId));

    return rows.map(rowToStoredSentence);
  },

  /**
   * Get sentence embeddings for specific segments.
   */
  async getBySegmentIds(
    documentId: string,
    segmentIds: string[]
  ): Promise<StoredSentenceEmbedding[]> {
    if (segmentIds.length === 0) return [];

    const rows = await db
      .select()
      .from(sentenceEmbeddings)
      .where(
        and(
          eq(sentenceEmbeddings.documentId, documentId),
          inArray(sentenceEmbeddings.segmentId, segmentIds)
        )
      );

    return rows.map(rowToStoredSentence);
  },

  /**
   * Find sentences similar to a query embedding.
   * Uses cosine similarity via pgvector.
   */
  async findSimilar(
    documentId: string,
    queryEmbedding: number[],
    limit: number = 10
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

    return (rows as any[]).map((row) => ({
      sentenceId: row.id,
      segmentId: row.segment_id,
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
    limit: number = 10
  ): Promise<SentenceSimilarityResult[]> {
    const queryEmbedding = await generateEmbedding(queryText);
    return this.findSimilar(documentId, queryEmbedding, limit);
  },

  /**
   * Delete all sentence embeddings for a document.
   */
  async deleteByDocumentId(documentId: string): Promise<void> {
    await db.delete(sentenceEmbeddings).where(eq(sentenceEmbeddings.documentId, documentId));
  },

  /**
   * Delete sentence embeddings for specific segments.
   */
  async deleteBySegmentIds(documentId: string, segmentIds: string[]): Promise<void> {
    if (segmentIds.length === 0) return;

    await db.delete(sentenceEmbeddings).where(
      and(
        eq(sentenceEmbeddings.documentId, documentId),
        inArray(sentenceEmbeddings.segmentId, segmentIds)
      )
    );
  },

  /**
   * Generate embeddings for multiple texts in batch.
   * Currently processes sequentially, could be parallelized.
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const embedding = await generateEmbedding(text);
      embeddings.push(embedding);
    }

    return embeddings;
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

function rowToStoredSentence(row: typeof sentenceEmbeddings.$inferSelect): StoredSentenceEmbedding {
  return {
    id: row.id,
    documentId: row.documentId,
    segmentId: row.segmentId,
    sentenceStart: row.sentenceStart,
    sentenceEnd: row.sentenceEnd,
    contentHash: row.contentHash,
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

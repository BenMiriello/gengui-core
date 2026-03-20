/**
 * Sentence embedding service.
 * Handles sentence extraction, embedding generation, and similarity search.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ANALYSIS_VERSIONS,
  type EmbeddingColumn,
  getCurrentAnalysisVersion,
  getVersionConfig,
} from '../../config/analysis-versions.js';
import { db } from '../../config/database';
import { sentenceEmbeddings } from '../../models/schema';
import { logger } from '../../utils/logger';
import { generateEmbeddings } from '../embeddings';
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
   * Returns sentences with embeddings. Throws on any failure.
   * @param analysisVersion - The analysis version to use for embeddings
   */
  async processSegment(
    documentId: string,
    segmentId: string,
    segmentText: string,
    analysisVersion?: string,
  ): Promise<SentenceWithEmbedding[]> {
    const version = analysisVersion ?? getCurrentAnalysisVersion();
    const versionConfig = getVersionConfig(version);
    const embeddingModel = versionConfig.embeddingModel;

    logger.info(
      {
        documentId,
        segmentId,
        textLength: segmentText.length,
        textPreview: segmentText.slice(0, 100),
      },
      'processSegment: starting',
    );

    const sentences = this.extractSentences(segmentText);
    logger.info(
      { documentId, segmentId, sentenceCount: sentences.length },
      'processSegment: extracted sentences',
    );

    if (sentences.length === 0) {
      return [];
    }

    const contentHashes = sentences.map((s) => s.contentHash);
    const cached = await this.getCachedByHashes(contentHashes, embeddingModel);
    const cachedMap = new Map(cached.map((c) => [c.contentHash, c.embedding]));

    const results: SentenceWithEmbedding[] = [];
    const toEmbed: Sentence[] = [];

    const toStoreFromCache: Array<{ sentence: Sentence; embedding: number[] }> =
      [];

    for (const sentence of sentences) {
      const cachedEmbedding = cachedMap.get(sentence.contentHash);
      if (cachedEmbedding) {
        results.push({ ...sentence, embedding: cachedEmbedding });
        toStoreFromCache.push({ sentence, embedding: cachedEmbedding });
      } else {
        toEmbed.push(sentence);
      }
    }

    // Store cached embeddings for this document (they exist for other docs but not this one)
    for (const { sentence, embedding } of toStoreFromCache) {
      await this.store(
        documentId,
        segmentId,
        sentence,
        embedding,
        embeddingModel,
        versionConfig.embeddingColumn,
      );
    }

    if (toEmbed.length > 0) {
      logger.info(
        { documentId, segmentId, toEmbedCount: toEmbed.length },
        'processSegment: generating embeddings',
      );
      let embeddings: number[][];
      try {
        embeddings = await this.generateBatchEmbeddings(
          toEmbed.map((s) => s.text),
          embeddingModel,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Embedding generation failed for segment ${segmentId}: ${msg}`,
        );
      }

      logger.info(
        { documentId, segmentId, embeddingsGenerated: embeddings.length },
        'processSegment: storing embeddings',
      );

      for (let i = 0; i < toEmbed.length; i++) {
        const sentence = toEmbed[i];
        const embedding = embeddings[i];

        results.push({ ...sentence, embedding });

        await this.store(
          documentId,
          segmentId,
          sentence,
          embedding,
          embeddingModel,
          versionConfig.embeddingColumn,
        );
      }
    }

    logger.info(
      { documentId, segmentId, resultCount: results.length },
      'processSegment: complete',
    );

    results.sort((a, b) => a.start - b.start);
    return results;
  },

  /**
   * Process all segments of a document.
   * Returns map of segmentId -> sentences with embeddings.
   * Throws on any failure.
   * @param analysisVersion - The analysis version to use for embeddings
   */
  async processDocument(
    documentId: string,
    documentContent: string,
    segments: Segment[],
    analysisVersion?: string,
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
          analysisVersion,
        );
        result.set(segment.id, sentences);
      },
      { concurrency: 3 },
    );

    return result;
  },

  /**
   * Store a sentence embedding using UPSERT.
   * Throws on failure (errors propagate to worker which sanitizes them).
   */
  async store(
    documentId: string,
    segmentId: string,
    sentence: Sentence,
    embedding: number[],
    embeddingModel: string,
    embeddingColumn: EmbeddingColumn,
  ): Promise<void> {
    const embeddingStr = `[${embedding.join(',')}]`;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (embeddingColumn === 'embedding_1536') {
          await db.execute(sql`
            INSERT INTO sentence_embeddings
              (document_id, segment_id, sentence_start, sentence_end, content_hash, embedding_model, embedding_1536)
            VALUES
              (${documentId}, ${segmentId}, ${sentence.start}, ${sentence.end}, ${sentence.contentHash}, ${embeddingModel}, ${embeddingStr}::vector)
            ON CONFLICT (document_id, segment_id, sentence_start, sentence_end, embedding_model)
            DO UPDATE SET
              embedding_1536 = EXCLUDED.embedding_1536,
              content_hash = EXCLUDED.content_hash,
              updated_at = NOW()
          `);
        } else {
          await db.execute(sql`
            INSERT INTO sentence_embeddings
              (document_id, segment_id, sentence_start, sentence_end, content_hash, embedding_model, embedding_1024)
            VALUES
              (${documentId}, ${segmentId}, ${sentence.start}, ${sentence.end}, ${sentence.contentHash}, ${embeddingModel}, ${embeddingStr}::vector)
            ON CONFLICT (document_id, segment_id, sentence_start, sentence_end, embedding_model)
            DO UPDATE SET
              embedding_1024 = EXCLUDED.embedding_1024,
              content_hash = EXCLUDED.content_hash,
              updated_at = NOW()
          `);
        }

        if (attempt > 0) {
          logger.info(
            { documentId, segmentId, attempts: attempt + 1 },
            'Sentence embedding storage succeeded after retry',
          );
        }
        return;
      } catch (err) {
        const isTransient =
          err instanceof Error &&
          (err.message.includes('ECONNREFUSED') ||
            err.message.includes('ECONNRESET') ||
            err.message.includes('timeout') ||
            err.message.includes('connection') ||
            err.message.includes('deadlock') ||
            err.message.includes('could not serialize') ||
            err.message.includes('lock') ||
            err.message.includes('EPIPE'));

        if (isTransient && attempt < maxRetries) {
          logger.warn(
            { documentId, segmentId, attempt: attempt + 1, maxRetries },
            'Retrying sentence embedding storage after transient error',
          );
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }

        throw err;
      }
    }
  },

  /**
   * Get cached embeddings by content hashes and model.
   */
  async getCachedByHashes(
    hashes: string[],
    embeddingModel: string,
  ): Promise<Array<{ contentHash: string; embedding: number[] }>> {
    if (hashes.length === 0) return [];

    const versionConfig = Object.values(ANALYSIS_VERSIONS).find(
      (v) => v.embeddingModel === embeddingModel,
    );

    const embeddingColumn = versionConfig?.embeddingColumn ?? 'embedding_1536';

    const rows = await db.execute(sql`
      SELECT DISTINCT
        content_hash,
        ${sql.raw(embeddingColumn)}::text as embedding_text
      FROM sentence_embeddings
      WHERE content_hash IN (${sql.join(
        hashes.map((h) => sql`${h}`),
        sql`, `,
      )})
      AND embedding_model = ${embeddingModel}
      AND ${sql.raw(embeddingColumn)} IS NOT NULL
    `);

    return (
      rows as unknown as { content_hash: string; embedding_text: string }[]
    ).map((row) => ({
      contentHash: row.content_hash,
      embedding: JSON.parse(row.embedding_text),
    }));
  },

  /**
   * Get all sentence embeddings for a document.
   * @param analysisVersion - Optional version to determine which column to read
   */
  async getByDocumentId(
    documentId: string,
    analysisVersion?: string,
  ): Promise<StoredSentenceEmbedding[]> {
    const version = analysisVersion ?? getCurrentAnalysisVersion();
    const versionConfig = getVersionConfig(version);
    const embeddingColumn = versionConfig.embeddingColumn;

    const rows = await db.execute(sql`
      SELECT
        id,
        document_id,
        segment_id,
        sentence_start,
        sentence_end,
        content_hash,
        embedding_model,
        ${sql.raw(embeddingColumn)}::text as embedding_text,
        created_at,
        updated_at
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
        AND ${sql.raw(embeddingColumn)} IS NOT NULL
    `);

    return (
      rows as unknown as Parameters<typeof rowToStoredSentenceFromRaw>[0][]
    ).map(rowToStoredSentenceFromRaw);
  },

  /**
   * Get sentence embeddings for specific segments.
   * @param analysisVersion - Optional version to determine which column to read
   */
  async getBySegmentIds(
    documentId: string,
    segmentIds: string[],
    analysisVersion?: string,
  ): Promise<StoredSentenceEmbedding[]> {
    if (segmentIds.length === 0) return [];

    const version = analysisVersion ?? getCurrentAnalysisVersion();
    const versionConfig = getVersionConfig(version);
    const embeddingColumn = versionConfig.embeddingColumn;

    const rows = await db.execute(sql`
      SELECT
        id,
        document_id,
        segment_id,
        sentence_start,
        sentence_end,
        content_hash,
        embedding_model,
        ${sql.raw(embeddingColumn)}::text as embedding_text,
        created_at,
        updated_at
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
        AND segment_id IN (${sql.join(
          segmentIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND ${sql.raw(embeddingColumn)} IS NOT NULL
    `);

    return (
      rows as unknown as Parameters<typeof rowToStoredSentenceFromRaw>[0][]
    ).map(rowToStoredSentenceFromRaw);
  },

  /**
   * Find sentences similar to a query embedding.
   * Uses cosine similarity via pgvector.
   * @param analysisVersion - The version to determine which column to search
   */
  async findSimilar(
    documentId: string,
    queryEmbedding: number[],
    limit: number = 10,
    analysisVersion?: string,
  ): Promise<SentenceSimilarityResult[]> {
    const version = analysisVersion ?? getCurrentAnalysisVersion();
    const versionConfig = getVersionConfig(version);
    const embeddingColumn = versionConfig.embeddingColumn;

    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const rows = await db.execute(sql`
      SELECT
        id,
        segment_id,
        sentence_start,
        sentence_end,
        1 - (${sql.raw(embeddingColumn)} <=> ${embeddingStr}::vector) as score
      FROM sentence_embeddings
      WHERE document_id = ${documentId}
        AND ${sql.raw(embeddingColumn)} IS NOT NULL
      ORDER BY ${sql.raw(embeddingColumn)} <=> ${embeddingStr}::vector
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
   * @param analysisVersion - The version to use for embedding and search
   */
  async findSimilarToText(
    documentId: string,
    queryText: string,
    limit: number = 10,
    analysisVersion?: string,
  ): Promise<SentenceSimilarityResult[]> {
    const version = analysisVersion ?? getCurrentAnalysisVersion();
    const versionConfig = getVersionConfig(version);

    const { generateEmbedding } = await import('../embeddings/index.js');
    const queryEmbedding = await generateEmbedding(
      queryText,
      versionConfig.embeddingModel,
    );
    return this.findSimilar(documentId, queryEmbedding, limit, version);
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
   * Uses batch API with event loop yields between batches.
   * @param embeddingModel - The model to use for embedding generation
   */
  async generateBatchEmbeddings(
    texts: string[],
    embeddingModel?: string,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 100;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await generateEmbeddings(batch, embeddingModel);
      results.push(...embeddings);

      if (i + BATCH_SIZE < texts.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return results;
  },

  /**
   * Compute average embedding for a set of sentence embeddings.
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

function rowToStoredSentenceFromRaw(row: {
  id: string;
  document_id: string;
  segment_id: string | null;
  sentence_start: number;
  sentence_end: number;
  content_hash: string;
  embedding_model: string;
  embedding_text: string;
  created_at: Date;
  updated_at: Date;
}): StoredSentenceEmbedding {
  return {
    id: row.id,
    documentId: row.document_id,
    segmentId: row.segment_id ?? '',
    sentenceStart: row.sentence_start,
    sentenceEnd: row.sentence_end,
    contentHash: row.content_hash,
    embeddingModel: row.embedding_model,
    embedding: JSON.parse(row.embedding_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

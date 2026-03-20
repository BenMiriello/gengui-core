/**
 * Entity-Document Similarity Service
 *
 * Computes semantic similarity between entity embeddings and document segments.
 * Used to generate gradient visualizations in the timeline panel showing where
 * entities are most semantically relevant within a document.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { documents } from '../../models/schema.js';
import { logger } from '../../utils/logger.js';
import { cosineSimilarity } from '../entityResolution/scoring.js';
import { graphService } from '../graph/graph.service.js';
import { redis } from '../redis.js';
import { segmentService } from '../segments/segment.service.js';
import { sentenceService } from '../sentences/sentence.service.js';

const CACHE_TTL_SECONDS = 3600;
const SERVICE_VERSION = 10;
const SEGMENT_WEIGHT = 0.33;
const SENTENCE_WEIGHT = 0.67;

export interface SentenceSimilarity {
  sentenceId: string;
  similarity: number;
  start: number;
  end: number;
}

export interface EntitySimilarityResult {
  entityId: string;
  similarities: SentenceSimilarity[];
  totalCharacters: number;
}

function getCacheKey(
  documentId: string,
  entityId: string,
  docVersion: number,
  analysisVersion: string,
): string {
  return `entity-similarity:s${SERVICE_VERSION}:${documentId}:${entityId}:v${docVersion}:${analysisVersion}`;
}

async function getDocumentVersion(documentId: string): Promise<number | null> {
  const [doc] = await db
    .select({ currentVersion: documents.currentVersion })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  return doc?.currentVersion ?? null;
}

export const entityDocumentSimilarityService = {
  /**
   * Compute semantic similarity between an entity and each sentence of a document.
   * Returns sentence-level granularity for smooth gradient rendering.
   * Results are cached in Redis keyed by document version and analysis version.
   */
  async computeEntitySimilarityForDocument(
    documentId: string,
    entityId: string,
    _userId: string,
    analysisVersion?: string,
  ): Promise<EntitySimilarityResult> {
    const version = analysisVersion ?? 'default';
    logger.info(
      { documentId, entityId, version },
      'entitySimilarity: starting',
    );

    const docVersion = await getDocumentVersion(documentId);
    if (docVersion === null) {
      logger.warn({ documentId, entityId }, 'entitySimilarity: no doc version');
      return { entityId, similarities: [], totalCharacters: 0 };
    }

    const cacheKey = getCacheKey(documentId, entityId, docVersion, version);
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info(
        { documentId, entityId },
        'entitySimilarity: returning cached',
      );
      return JSON.parse(cached) as EntitySimilarityResult;
    }

    const entityEmbedding = await graphService.getNodeEmbedding(
      entityId,
      analysisVersion,
    );
    if (!entityEmbedding) {
      logger.warn(
        { documentId, entityId },
        'entitySimilarity: no entity embedding',
      );
      return { entityId, similarities: [], totalCharacters: 0 };
    }
    logger.info(
      { documentId, entityId, embeddingLen: entityEmbedding.length },
      'entitySimilarity: got entity embedding',
    );

    const segments = await segmentService.getDocumentSegments(documentId);
    if (segments.length === 0) {
      logger.warn({ documentId, entityId }, 'entitySimilarity: no segments');
      return { entityId, similarities: [], totalCharacters: 0 };
    }

    const totalCharacters = Math.max(...segments.map((s) => s.end));
    logger.info(
      { documentId, entityId, segmentCount: segments.length, totalCharacters },
      'entitySimilarity: got segments',
    );

    const segmentIds = segments.map((s) => s.id);
    const sentences = await sentenceService.getBySegmentIds(
      documentId,
      segmentIds,
      analysisVersion,
    );

    // Map segment IDs to their absolute start positions
    const segmentStartMap = new Map<string, number>();
    for (const segment of segments) {
      segmentStartMap.set(segment.id, segment.start);
    }

    // Group sentences by segment for segment-level similarity computation
    const sentencesBySegment = new Map<string, typeof sentences>();
    for (const sentence of sentences) {
      if (!sentence.embedding) continue;
      const existing = sentencesBySegment.get(sentence.segmentId) ?? [];
      existing.push(sentence);
      sentencesBySegment.set(sentence.segmentId, existing);
    }

    // Compute segment-level similarities (average of sentence embeddings per segment)
    const segmentSimilarityMap = new Map<string, number>();
    for (const [segmentId, segmentSentences] of sentencesBySegment) {
      const embeddings = segmentSentences
        .map((s) => s.embedding)
        .filter((e): e is number[] => e !== null);
      if (embeddings.length > 0) {
        const avgEmbedding =
          sentenceService.computeAverageEmbedding(embeddings);
        segmentSimilarityMap.set(
          segmentId,
          Math.max(0, cosineSimilarity(entityEmbedding, avgEmbedding)),
        );
      }
    }

    const similarities: SentenceSimilarity[] = [];

    for (const sentence of sentences) {
      if (!sentence.embedding) continue;

      // Convert segment-relative positions to absolute document positions
      const segmentStart = segmentStartMap.get(sentence.segmentId) ?? 0;

      // Compute blended similarity: 50% sentence-level + 50% segment-level
      const sentenceSimilarity = Math.max(
        0,
        cosineSimilarity(entityEmbedding, sentence.embedding),
      );
      const segmentSimilarity =
        segmentSimilarityMap.get(sentence.segmentId) ?? 0;
      const blendedSimilarity =
        SENTENCE_WEIGHT * sentenceSimilarity +
        SEGMENT_WEIGHT * segmentSimilarity;

      similarities.push({
        sentenceId: sentence.id,
        similarity: blendedSimilarity,
        start: segmentStart + sentence.sentenceStart,
        end: segmentStart + sentence.sentenceEnd,
      });
    }

    similarities.sort((a, b) => a.start - b.start);

    const processedSimilarities = this.postProcessSimilarities(similarities);

    const result: EntitySimilarityResult = {
      entityId,
      similarities: processedSimilarities,
      totalCharacters,
    };
    logger.info(
      { documentId, entityId, sentenceCount: similarities.length },
      'entitySimilarity: computed sentence-level similarities',
    );

    await redis.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);

    return result;
  },

  /**
   * Apply S-curve transformation for better visualization.
   * - Flatter at low values (compresses noise floor)
   * - Steeper in middle (enhances differentiation)
   * - Flatter at high values (doesn't over-exaggerate peaks)
   * - NO per-entity normalization (preserves absolute relevance differences)
   */
  postProcessSimilarities(
    similarities: SentenceSimilarity[],
  ): SentenceSimilarity[] {
    if (similarities.length === 0) return [];

    // S-curve blend factor: 0 = linear, 1 = full S-curve
    // 1.0 = full S-curve
    const BLEND = 1.0;

    return similarities.map((s) => {
      // Clamp to [0, 1] just in case
      const x = Math.max(0, Math.min(1, s.similarity));

      // Full S-curve using cosine
      const sCurve = 0.5 * (1 - Math.cos(x * Math.PI));

      // Blend between linear and S-curve
      const scaled = (1 - BLEND) * x + BLEND * sCurve;

      return { ...s, similarity: scaled };
    });
  },
};

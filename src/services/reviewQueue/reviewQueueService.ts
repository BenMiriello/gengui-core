/**
 * Review Queue Service
 *
 * Manages the queue of items requiring user review.
 * Per TDD 2026-02-21 Section 7.
 *
 * Review items include:
 * - Contradictions: Two facets conflict
 * - Merge suggestions: Entities may be same
 * - Gap detected: State transition without trigger
 * - Low confidence: Extraction below threshold
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { reviewQueue } from '../../models/schema';
import { logger } from '../../utils/logger';

export type ReviewItemType =
  | 'contradiction'
  | 'merge_suggestion'
  | 'gap_detected'
  | 'low_confidence';

export type ReviewStatus = 'pending' | 'resolved' | 'dismissed';

export type ConflictType =
  | 'temporal_change'
  | 'arc_divergence'
  | 'true_inconsistency'
  | 'perspective_difference';

export interface AddReviewItemInput {
  documentId: string;
  itemType: ReviewItemType;
  primaryEntityId?: string;
  secondaryEntityId?: string;
  facetIds?: string[];
  stateIds?: string[];
  contextSummary: string;
  sourcePositions?: Record<string, unknown>;
  conflictType?: ConflictType;
  similarity?: number;
}

export interface ReviewItem {
  id: string;
  documentId: string;
  itemType: ReviewItemType;
  primaryEntityId: string | null;
  secondaryEntityId: string | null;
  facetIds: string[] | null;
  stateIds: string[] | null;
  contextSummary: string;
  sourcePositions: Record<string, unknown> | null;
  conflictType: string | null;
  similarity: number | null;
  status: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ResolveInput {
  reviewItemId: string;
  userId: string;
  resolution: Record<string, unknown>;
}

export interface ReviewQueueStats {
  pending: number;
  resolved: number;
  dismissed: number;
  byType: Record<ReviewItemType, number>;
}

export const reviewQueueService = {
  /**
   * Add an item to the review queue.
   */
  async add(input: AddReviewItemInput): Promise<ReviewItem> {
    const [item] = await db
      .insert(reviewQueue)
      .values({
        documentId: input.documentId,
        itemType: input.itemType,
        primaryEntityId: input.primaryEntityId,
        secondaryEntityId: input.secondaryEntityId,
        facetIds: input.facetIds,
        stateIds: input.stateIds,
        contextSummary: input.contextSummary,
        sourcePositions: input.sourcePositions,
        conflictType: input.conflictType,
        similarity: input.similarity ? Math.round(input.similarity * 100) : null,
      })
      .returning();

    logger.info(
      {
        reviewItemId: item.id,
        documentId: input.documentId,
        itemType: input.itemType,
        entityId: input.primaryEntityId,
      },
      'Review item added to queue',
    );

    return this.mapToReviewItem(item);
  },

  /**
   * Get pending review items for a document.
   */
  async getPendingForDocument(
    documentId: string,
    limit: number = 50,
  ): Promise<ReviewItem[]> {
    const items = await db
      .select()
      .from(reviewQueue)
      .where(
        and(
          eq(reviewQueue.documentId, documentId),
          eq(reviewQueue.status, 'pending'),
        ),
      )
      .orderBy(desc(reviewQueue.createdAt))
      .limit(limit);

    return items.map((item) => this.mapToReviewItem(item));
  },

  /**
   * Get all review items for a document.
   */
  async getAllForDocument(
    documentId: string,
    status?: ReviewStatus,
    limit: number = 100,
  ): Promise<ReviewItem[]> {
    const conditions = [eq(reviewQueue.documentId, documentId)];

    if (status) {
      conditions.push(eq(reviewQueue.status, status));
    }

    const items = await db
      .select()
      .from(reviewQueue)
      .where(and(...conditions))
      .orderBy(desc(reviewQueue.createdAt))
      .limit(limit);

    return items.map((item) => this.mapToReviewItem(item));
  },

  /**
   * Get a single review item by ID.
   */
  async getById(reviewItemId: string): Promise<ReviewItem | null> {
    const [item] = await db
      .select()
      .from(reviewQueue)
      .where(eq(reviewQueue.id, reviewItemId))
      .limit(1);

    return item ? this.mapToReviewItem(item) : null;
  },

  /**
   * Resolve a review item.
   */
  async resolve(input: ResolveInput): Promise<ReviewItem> {
    const [item] = await db
      .update(reviewQueue)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: input.userId,
        resolution: input.resolution,
      })
      .where(eq(reviewQueue.id, input.reviewItemId))
      .returning();

    if (!item) {
      throw new Error(`Review item not found: ${input.reviewItemId}`);
    }

    logger.info(
      {
        reviewItemId: input.reviewItemId,
        userId: input.userId,
        resolution: input.resolution,
      },
      'Review item resolved',
    );

    return this.mapToReviewItem(item);
  },

  /**
   * Dismiss a review item (mark as not needing action).
   */
  async dismiss(
    reviewItemId: string,
    userId: string,
    reason?: string,
  ): Promise<ReviewItem> {
    const [item] = await db
      .update(reviewQueue)
      .set({
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedBy: userId,
        resolution: reason ? { type: 'dismissed', reason } : { type: 'dismissed' },
      })
      .where(eq(reviewQueue.id, reviewItemId))
      .returning();

    if (!item) {
      throw new Error(`Review item not found: ${reviewItemId}`);
    }

    logger.info(
      { reviewItemId, userId, reason },
      'Review item dismissed',
    );

    return this.mapToReviewItem(item);
  },

  /**
   * Get statistics for a document's review queue.
   */
  async getStats(documentId: string): Promise<ReviewQueueStats> {
    const result = await db
      .select({
        status: reviewQueue.status,
        itemType: reviewQueue.itemType,
        count: sql<number>`count(*)::int`,
      })
      .from(reviewQueue)
      .where(eq(reviewQueue.documentId, documentId))
      .groupBy(reviewQueue.status, reviewQueue.itemType);

    const stats: ReviewQueueStats = {
      pending: 0,
      resolved: 0,
      dismissed: 0,
      byType: {
        contradiction: 0,
        merge_suggestion: 0,
        gap_detected: 0,
        low_confidence: 0,
      },
    };

    for (const row of result) {
      const count = row.count;

      // Count by status
      if (row.status === 'pending') {
        stats.pending += count;
      } else if (row.status === 'resolved') {
        stats.resolved += count;
      } else if (row.status === 'dismissed') {
        stats.dismissed += count;
      }

      // Count by type (only pending items)
      if (row.status === 'pending' && row.itemType in stats.byType) {
        stats.byType[row.itemType as ReviewItemType] += count;
      }
    }

    return stats;
  },

  /**
   * Get pending count for a document (for badge display).
   */
  async getPendingCount(documentId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reviewQueue)
      .where(
        and(
          eq(reviewQueue.documentId, documentId),
          eq(reviewQueue.status, 'pending'),
        ),
      );

    return result[0]?.count ?? 0;
  },

  /**
   * Check if an entity has pending review items.
   */
  async hasPendingReviews(entityId: string): Promise<boolean> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reviewQueue)
      .where(
        and(
          eq(reviewQueue.primaryEntityId, entityId),
          eq(reviewQueue.status, 'pending'),
        ),
      )
      .limit(1);

    return (result[0]?.count ?? 0) > 0;
  },

  /**
   * Map database row to ReviewItem type.
   */
  mapToReviewItem(row: typeof reviewQueue.$inferSelect): ReviewItem {
    return {
      id: row.id,
      documentId: row.documentId,
      itemType: row.itemType as ReviewItemType,
      primaryEntityId: row.primaryEntityId,
      secondaryEntityId: row.secondaryEntityId,
      facetIds: row.facetIds,
      stateIds: row.stateIds,
      contextSummary: row.contextSummary,
      sourcePositions: row.sourcePositions as Record<string, unknown> | null,
      conflictType: row.conflictType,
      similarity: row.similarity,
      status: row.status,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
      resolution: row.resolution as Record<string, unknown> | null,
      createdAt: row.createdAt,
    };
  },
};

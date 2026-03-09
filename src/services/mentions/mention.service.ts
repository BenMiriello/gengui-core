/**
 * Mention service - CRUD operations for the mentions table.
 * Handles linking graph nodes to text positions in documents.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { mentions } from '../../models/schema';
import type { Segment } from '../segments';
import { segmentService } from '../segments';
import { fuzzyFindText, fuzzyFindTextInSegment } from './fuzzyMatch';
import type {
  CreateMentionInput,
  Mention,
  MentionWithAbsolutePosition,
} from './mention.types';
import { findNameOccurrences, nameMatchesToMentionInputs } from './nameMatch';

export const mentionService = {
  /**
   * Create a mention from absolute document positions.
   * Automatically converts to segment-relative positions.
   */
  async createFromAbsolutePosition(
    nodeId: string,
    documentId: string,
    absoluteStart: number,
    absoluteEnd: number,
    originalText: string,
    versionNumber: number,
    segments: Segment[],
    source: CreateMentionInput['source'] = 'extraction',
    confidence = 100,
    facetId?: string | null,
  ): Promise<Mention | null> {
    const relative = segmentService.toRelativePosition(
      segments,
      absoluteStart,
      absoluteEnd,
    );
    if (!relative) {
      return null;
    }

    return this.create({
      nodeId,
      documentId,
      segmentId: relative.segmentId,
      facetId: facetId ?? null,
      relativeStart: relative.relativeStart,
      relativeEnd: relative.relativeEnd,
      originalText,
      versionNumber,
      source,
      confidence,
    });
  },

  /**
   * Create a mention from absolute positions, idempotently.
   * Returns existing mention if one exists at same position.
   */
  async createFromAbsolutePositionIdempotent(
    nodeId: string,
    documentId: string,
    absoluteStart: number,
    absoluteEnd: number,
    originalText: string,
    versionNumber: number,
    segments: Segment[],
    source: CreateMentionInput['source'] = 'extraction',
    confidence = 100,
    facetId?: string | null,
  ): Promise<Mention | null> {
    const relative = segmentService.toRelativePosition(
      segments,
      absoluteStart,
      absoluteEnd,
    );
    if (!relative) {
      return null;
    }

    return this.createIdempotent({
      nodeId,
      documentId,
      segmentId: relative.segmentId,
      facetId: facetId ?? null,
      relativeStart: relative.relativeStart,
      relativeEnd: relative.relativeEnd,
      originalText,
      versionNumber,
      source,
      confidence,
    });
  },

  /**
   * Create a mention with segment-relative positions.
   */
  async create(input: CreateMentionInput): Promise<Mention> {
    const textHash = computeTextHash(input.originalText);
    const isKeyPassage = input.source === 'extraction';

    const [row] = await db
      .insert(mentions)
      .values({
        nodeId: input.nodeId,
        documentId: input.documentId,
        segmentId: input.segmentId,
        facetId: input.facetId ?? null,
        relativeStart: input.relativeStart,
        relativeEnd: input.relativeEnd,
        originalText: input.originalText,
        textHash,
        confidence: input.confidence ?? 100,
        versionNumber: input.versionNumber,
        source: input.source,
        isKeyPassage,
      })
      .returning();

    return rowToMention(row);
  },

  /**
   * Create a mention idempotently - checks for existing mention at same position.
   * Returns existing mention if found, creates new one otherwise.
   */
  async createIdempotent(input: CreateMentionInput): Promise<Mention> {
    // Check for existing mention at same node+segment+position
    const existing = await db
      .select()
      .from(mentions)
      .where(
        and(
          eq(mentions.nodeId, input.nodeId),
          eq(mentions.segmentId, input.segmentId),
          eq(mentions.relativeStart, input.relativeStart),
          eq(mentions.relativeEnd, input.relativeEnd),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return rowToMention(existing[0]);
    }

    return this.create(input);
  },

  /**
   * Create multiple mentions in a batch.
   */
  async createBatch(inputs: CreateMentionInput[]): Promise<Mention[]> {
    if (inputs.length === 0) return [];

    const values = inputs.map((input) => ({
      nodeId: input.nodeId,
      documentId: input.documentId,
      segmentId: input.segmentId,
      facetId: input.facetId ?? null,
      relativeStart: input.relativeStart,
      relativeEnd: input.relativeEnd,
      originalText: input.originalText,
      textHash: computeTextHash(input.originalText),
      confidence: input.confidence ?? 100,
      versionNumber: input.versionNumber,
      source: input.source,
      isKeyPassage: input.source === 'extraction',
    }));

    const rows = await db.insert(mentions).values(values).returning();
    return rows.map(rowToMention);
  },

  /**
   * Get all mentions for a node.
   */
  async getByNodeId(nodeId: string): Promise<Mention[]> {
    const rows = await db
      .select()
      .from(mentions)
      .where(eq(mentions.nodeId, nodeId));

    return rows.map(rowToMention);
  },

  /**
   * Get all mentions for a node filtered by source type.
   */
  async getByNodeIdAndSource(
    nodeId: string,
    source: 'extraction' | 'name_match' | 'reference' | 'semantic',
  ): Promise<Mention[]> {
    const rows = await db
      .select()
      .from(mentions)
      .where(and(eq(mentions.nodeId, nodeId), eq(mentions.source, source)));

    return rows.map(rowToMention);
  },

  /**
   * Get all mentions for a document.
   */
  async getByDocumentId(documentId: string): Promise<Mention[]> {
    const rows = await db
      .select()
      .from(mentions)
      .where(eq(mentions.documentId, documentId));

    return rows.map(rowToMention);
  },

  /**
   * Get all mentions for a document with absolute positions.
   * Uses fuzzy matching fallback when segment IDs are stale.
   */
  async getByDocumentIdWithAbsolutePositions(
    documentId: string,
  ): Promise<MentionWithAbsolutePosition[]> {
    const { documents } = await import('../../models/schema.js');

    const [doc] = await db
      .select({
        segmentSequence: documents.segmentSequence,
        content: documents.content,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) return [];

    const segments = doc.segmentSequence as Segment[];
    const content = doc.content || '';
    const mentionRows = await this.getByDocumentId(documentId);

    const results: MentionWithAbsolutePosition[] = [];

    for (const mention of mentionRows) {
      let absolute = segmentService.toAbsolutePosition(
        segments,
        mention.segmentId,
        mention.relativeStart,
        mention.relativeEnd,
      );
      let positionConfidence = 1.0;

      if (!absolute) {
        const resolved = this.resolveMentionPosition(
          mention,
          content,
          segments,
        );
        if (!resolved) continue;
        absolute = {
          absoluteStart: resolved.absoluteStart,
          absoluteEnd: resolved.absoluteEnd,
        };
        positionConfidence = resolved.confidence;
      }

      results.push({
        ...mention,
        absoluteStart: absolute.absoluteStart,
        absoluteEnd: absolute.absoluteEnd,
        positionConfidence,
      });
    }

    return results;
  },

  /**
   * Get a single mention by ID with absolute positions.
   * Uses fuzzy matching fallback when segment IDs are stale.
   */
  async getMentionById(
    id: string,
  ): Promise<MentionWithAbsolutePosition | null> {
    const [row] = await db
      .select()
      .from(mentions)
      .where(eq(mentions.id, id))
      .limit(1);

    if (!row) return null;

    const { documents } = await import('../../models/schema.js');
    const [doc] = await db
      .select({
        segmentSequence: documents.segmentSequence,
        content: documents.content,
      })
      .from(documents)
      .where(eq(documents.id, row.documentId))
      .limit(1);

    if (!doc) return null;

    const segments = doc.segmentSequence as Segment[];
    const content = doc.content || '';
    const mention = rowToMention(row);

    let absolute = segmentService.toAbsolutePosition(
      segments,
      row.segmentId,
      row.relativeStart,
      row.relativeEnd,
    );
    let confidence = 1.0;

    if (!absolute) {
      const resolved = this.resolveMentionPosition(mention, content, segments);
      if (!resolved) return null;
      absolute = {
        absoluteStart: resolved.absoluteStart,
        absoluteEnd: resolved.absoluteEnd,
      };
      confidence = resolved.confidence;
    }

    return {
      ...mention,
      absoluteStart: absolute.absoluteStart,
      absoluteEnd: absolute.absoluteEnd,
      positionConfidence: confidence,
    };
  },

  /**
   * Get mentions with absolute positions (requires segments).
   */
  async getByNodeIdWithAbsolutePositions(
    nodeId: string,
    segments: Segment[],
  ): Promise<MentionWithAbsolutePosition[]> {
    const mentionRows = await this.getByNodeId(nodeId);

    return mentionRows
      .map((mention) => {
        const absolute = segmentService.toAbsolutePosition(
          segments,
          mention.segmentId,
          mention.relativeStart,
          mention.relativeEnd,
        );
        if (!absolute) return null;

        return {
          ...mention,
          absoluteStart: absolute.absoluteStart,
          absoluteEnd: absolute.absoluteEnd,
        };
      })
      .filter((m): m is MentionWithAbsolutePosition => m !== null);
  },

  /**
   * Delete all mentions for a node.
   */
  async deleteByNodeId(nodeId: string): Promise<void> {
    await db.delete(mentions).where(eq(mentions.nodeId, nodeId));
  },

  /**
   * Delete all mentions for a document.
   */
  async deleteByDocumentId(documentId: string): Promise<void> {
    await db.delete(mentions).where(eq(mentions.documentId, documentId));
  },

  /**
   * Delete mentions by node IDs.
   */
  async deleteByNodeIds(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    await db.delete(mentions).where(inArray(mentions.nodeId, nodeIds));
  },

  /**
   * Get the minimum absolute position across all mentions for a node.
   * Used to compute documentOrder.
   */
  async getFirstPosition(
    nodeId: string,
    segments: Segment[],
  ): Promise<number | null> {
    const mentionsWithPos = await this.getByNodeIdWithAbsolutePositions(
      nodeId,
      segments,
    );

    if (mentionsWithPos.length === 0) return null;

    return Math.min(...mentionsWithPos.map((m) => m.absoluteStart));
  },

  /**
   * Validate a mention's text hash against current document content.
   * Returns true if the text at the stored position matches the hash.
   */
  validateMention(
    mention: Mention,
    documentContent: string,
    segments: Segment[],
  ): boolean {
    const absolute = segmentService.toAbsolutePosition(
      segments,
      mention.segmentId,
      mention.relativeStart,
      mention.relativeEnd,
    );

    if (!absolute) return false;

    const currentText = documentContent.slice(
      absolute.absoluteStart,
      absolute.absoluteEnd,
    );
    const currentHash = computeTextHash(currentText);

    return currentHash === mention.textHash;
  },

  /**
   * Update the isKeyPassage flag for a mention.
   */
  async updateKeyPassage(
    mentionId: string,
    isKeyPassage: boolean,
  ): Promise<void> {
    await db
      .update(mentions)
      .set({ isKeyPassage })
      .where(eq(mentions.id, mentionId));
  },

  /**
   * Get mention counts grouped by facet ID for a node.
   * Used for weighting entity embeddings by mention frequency.
   */
  async getMentionCountsByFacet(nodeId: string): Promise<Map<string, number>> {
    const rows = await db
      .select({
        facetId: mentions.facetId,
        count: sql<number>`count(*)::int`,
      })
      .from(mentions)
      .where(eq(mentions.nodeId, nodeId))
      .groupBy(mentions.facetId);

    const result = new Map<string, number>();
    for (const row of rows) {
      if (row.facetId) {
        result.set(row.facetId, row.count);
      }
    }
    return result;
  },

  /**
   * Get mentions by segment ID.
   */
  async getBySegmentId(
    documentId: string,
    segmentId: string,
  ): Promise<Mention[]> {
    const rows = await db
      .select()
      .from(mentions)
      .where(
        and(
          eq(mentions.documentId, documentId),
          eq(mentions.segmentId, segmentId),
        ),
      );

    return rows.map(rowToMention);
  },

  /**
   * Get total mention count for a node.
   */
  async getMentionCount(nodeId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mentions)
      .where(eq(mentions.nodeId, nodeId));

    return row?.count || 0;
  },

  /**
   * Get mention counts for multiple nodes.
   * Returns map of nodeId -> count.
   */
  async getMentionCountsByNodes(
    nodeIds: string[],
  ): Promise<Map<string, number>> {
    if (nodeIds.length === 0) return new Map();

    const rows = await db
      .select({
        nodeId: mentions.nodeId,
        count: sql<number>`count(*)::int`,
      })
      .from(mentions)
      .where(inArray(mentions.nodeId, nodeIds))
      .groupBy(mentions.nodeId);

    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.nodeId, row.count);
    }
    return result;
  },

  /**
   * Resolve a mention's absolute position using fuzzy matching.
   * Falls back from segment-local search to full document search.
   */
  resolveMentionPosition(
    mention: Mention,
    documentContent: string,
    segments: Segment[],
  ): { absoluteStart: number; absoluteEnd: number; confidence: number } | null {
    const segment = segments.find((s) => s.id === mention.segmentId);

    if (segment) {
      const absoluteStart = segment.start + mention.relativeStart;
      const absoluteEnd = segment.start + mention.relativeEnd;
      const currentText = documentContent.slice(absoluteStart, absoluteEnd);

      if (computeTextHash(currentText) === mention.textHash) {
        return { absoluteStart, absoluteEnd, confidence: 1.0 };
      }

      const result = fuzzyFindTextInSegment(
        documentContent,
        {
          sourceText: mention.originalText,
          originalStart: absoluteStart,
          originalEnd: absoluteEnd,
        },
        segments,
        segment.id,
      );

      if (result && result.confidence >= 0.5) {
        return {
          absoluteStart: result.start,
          absoluteEnd: result.end,
          confidence: result.confidence,
        };
      }
    }

    const fullResult = fuzzyFindText(documentContent, {
      sourceText: mention.originalText,
      originalStart: 0,
      originalEnd: mention.originalText.length,
    });

    if (fullResult && fullResult.confidence >= 0.5) {
      return {
        absoluteStart: fullResult.start,
        absoluteEnd: fullResult.end,
        confidence: fullResult.confidence,
      };
    }

    return null;
  },

  /**
   * Run name matching for a node and create mentions.
   * Excludes spans that already have extraction-source mentions.
   */
  async runNameMatchingForNode(
    nodeId: string,
    documentId: string,
    documentContent: string,
    segments: Segment[],
    versionNumber: number,
    name: string,
    aliases: string[] = [],
  ): Promise<number> {
    // Get existing mentions to exclude their spans
    const existingMentions = await this.getByNodeIdWithAbsolutePositions(
      nodeId,
      segments,
    );
    const excludeSpans = existingMentions.map((m) => ({
      start: m.absoluteStart,
      end: m.absoluteEnd,
    }));

    // Find name occurrences
    const matches = findNameOccurrences(documentContent, name, aliases, {
      excludeExistingSpans: excludeSpans,
      minConfidence: 70,
    });

    if (matches.length === 0) return 0;

    // Convert to mention inputs and create
    const inputs = nameMatchesToMentionInputs(
      nodeId,
      documentId,
      matches,
      segments,
      versionNumber,
    );

    await this.createBatch(inputs);
    return inputs.length;
  },
};

function computeTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

function rowToMention(row: typeof mentions.$inferSelect): Mention {
  return {
    id: row.id,
    nodeId: row.nodeId,
    documentId: row.documentId,
    segmentId: row.segmentId,
    facetId: row.facetId,
    relativeStart: row.relativeStart,
    relativeEnd: row.relativeEnd,
    originalText: row.originalText,
    textHash: row.textHash,
    confidence: row.confidence,
    versionNumber: row.versionNumber,
    source: row.source as Mention['source'],
    isKeyPassage: row.isKeyPassage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

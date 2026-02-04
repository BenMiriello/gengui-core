/**
 * Segment service - orchestrates segmentation and document integration.
 * Handles persistence and lookup operations.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents } from '../../models/schema';
import { segmentText } from './segment.detector';
import type { Segment, SegmentMatch } from './segment.types';

export const segmentService = {
  /**
   * Compute segments for document content.
   * Reuses existing segment IDs where positions match.
   */
  computeSegments(content: string, existingSegments?: Segment[]): Segment[] {
    const { segments } = segmentText(content, existingSegments);
    return segments;
  },

  /**
   * Update document's segmentSequence after content change.
   * Returns the new segments.
   */
  async updateDocumentSegments(documentId: string): Promise<Segment[]> {
    const [doc] = await db
      .select({ content: documents.content, segmentSequence: documents.segmentSequence })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const existingSegments = parseSegmentSequence(doc.segmentSequence);
    const newSegments = this.computeSegments(doc.content, existingSegments);

    await db
      .update(documents)
      .set({ segmentSequence: newSegments })
      .where(eq(documents.id, documentId));

    return newSegments;
  },

  /**
   * Get segments for a document.
   */
  async getDocumentSegments(documentId: string): Promise<Segment[]> {
    const [doc] = await db
      .select({ segmentSequence: documents.segmentSequence })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return parseSegmentSequence(doc.segmentSequence);
  },

  /**
   * Find which segment contains a given absolute position.
   */
  findSegmentAtPosition(segments: Segment[], absolutePosition: number): SegmentMatch | null {
    for (const segment of segments) {
      if (absolutePosition >= segment.start && absolutePosition < segment.end) {
        return {
          segmentId: segment.id,
          segmentStart: segment.start,
          segmentEnd: segment.end,
        };
      }
    }
    return null;
  },

  /**
   * Convert absolute position to segment-relative position.
   */
  toRelativePosition(
    segments: Segment[],
    absoluteStart: number,
    absoluteEnd: number
  ): { segmentId: string; relativeStart: number; relativeEnd: number } | null {
    const match = this.findSegmentAtPosition(segments, absoluteStart);
    if (!match) return null;

    return {
      segmentId: match.segmentId,
      relativeStart: absoluteStart - match.segmentStart,
      relativeEnd: absoluteEnd - match.segmentStart,
    };
  },

  /**
   * Convert segment-relative position to absolute position.
   */
  toAbsolutePosition(
    segments: Segment[],
    segmentId: string,
    relativeStart: number,
    relativeEnd: number
  ): { absoluteStart: number; absoluteEnd: number } | null {
    const segment = segments.find(s => s.id === segmentId);
    if (!segment) return null;

    return {
      absoluteStart: segment.start + relativeStart,
      absoluteEnd: segment.start + relativeEnd,
    };
  },

  /**
   * Get segment by ID.
   */
  getSegmentById(segments: Segment[], segmentId: string): Segment | undefined {
    return segments.find(s => s.id === segmentId);
  },

  /**
   * Get text content of a specific segment.
   */
  getSegmentText(content: string, segment: Segment): string {
    return content.slice(segment.start, segment.end);
  },
};

function parseSegmentSequence(raw: unknown): Segment[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (s): s is Segment =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.id === 'string' &&
        typeof s.start === 'number' &&
        typeof s.end === 'number'
    );
  }
  return [];
}

/**
 * Unified position relocation for anchored content (mentions, text types, media).
 *
 * Resolves stored segment-relative positions to absolute document positions,
 * handling drift from user edits via a 4-layer algorithm:
 *   L1: Exact position check against current content
 *   L2: Sentence-structure relocation (future)
 *   L3: Fuzzy text search (two-stage candidate filtering + Levenshtein)
 *   L4: Declare stale
 */

import { createHash } from 'node:crypto';
import { fuzzyFindText, fuzzyFindTextInSegment } from './mentions/fuzzyMatch';
import type { Segment } from './segments/segment.types';

export interface AnchorInput {
  segmentId: string;
  relativeStart: number;
  relativeEnd: number;

  sourceText?: string;
  boundaryText?: string;
}

export interface AnchorResult {
  absoluteStart: number;
  absoluteEnd: number;
  confidence: number;
  status: 'exact' | 'relocated' | 'fuzzy' | 'stale';
}

/**
 * Resolve an anchor's absolute position in the current document content.
 *
 * Uses `textHash` for cheap Layer 1 exact checks when available,
 * then falls through to Layer 3 fuzzy search.
 */
export function resolveAnchor(
  content: string,
  segments: Segment[],
  anchor: AnchorInput,
  textHash?: string,
): AnchorResult | null {
  const searchText = anchor.sourceText ?? anchor.boundaryText;
  if (!searchText) return null;

  const segment = segments.find((s) => s.id === anchor.segmentId);

  // Layer 1: Exact position check
  if (segment) {
    const absoluteStart = segment.start + anchor.relativeStart;
    const absoluteEnd = segment.start + anchor.relativeEnd;
    const currentText = content.slice(absoluteStart, absoluteEnd);

    if (textHash) {
      const currentHash = createHash('sha256')
        .update(currentText)
        .digest('hex')
        .slice(0, 64);
      if (currentHash === textHash) {
        return { absoluteStart, absoluteEnd, confidence: 1.0, status: 'exact' };
      }
    } else if (
      currentText === searchText ||
      (searchText && currentText.startsWith(searchText))
    ) {
      return { absoluteStart, absoluteEnd, confidence: 1.0, status: 'exact' };
    }

    // Layer 3: Fuzzy search — segment-local first, then full document
    const result = fuzzyFindTextInSegment(
      content,
      {
        sourceText: searchText,
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
        status: result.confidence >= 0.8 ? 'relocated' : 'fuzzy',
      };
    }
  }

  // Segment not found or segment-local search failed — full document search
  const fullResult = fuzzyFindText(content, {
    sourceText: searchText,
    originalStart: 0,
    originalEnd: searchText.length,
  });

  if (fullResult && fullResult.confidence >= 0.5) {
    return {
      absoluteStart: fullResult.start,
      absoluteEnd: fullResult.end,
      confidence: fullResult.confidence,
      status: fullResult.confidence >= 0.8 ? 'relocated' : 'fuzzy',
    };
  }

  // Layer 4: Stale
  return null;
}

/**
 * Resolve a text type annotation's position.
 *
 * text_hash from coverage is the segment hash (not a region hash), so we
 * don't pass it to resolveAnchor. Layer 1 uses startsWith(boundaryText)
 * instead. For non-exact results (fuzzy match on ~30-char boundary_text),
 * the end position is extended using the original region length.
 */
export function resolveTextTypeAnchor(
  content: string,
  segments: Segment[],
  annotation: {
    segment_id: string;
    char_start: number;
    char_end: number;
    boundary_text: string;
    text_hash: string;
  },
): AnchorResult | null {
  const regionLength = annotation.char_end - annotation.char_start;

  const result = resolveAnchor(content, segments, {
    segmentId: annotation.segment_id,
    relativeStart: annotation.char_start,
    relativeEnd: annotation.char_end,
    boundaryText: annotation.boundary_text,
  });

  if (!result) return null;

  // Layer 1 exact match returns correct full-region positions.
  // Fuzzy match found only the boundary_text start — extend to full region.
  if (result.status !== 'exact') {
    return {
      ...result,
      absoluteEnd: result.absoluteStart + regionLength,
    };
  }

  return result;
}

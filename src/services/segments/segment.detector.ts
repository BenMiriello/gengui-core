/**
 * Pure functions for detecting segment boundaries in text.
 * No side effects, no I/O - just text processing.
 */

import { randomUUID } from 'node:crypto';
import type {
  Segment,
  SegmentationResult,
  SegmentBoundary,
} from './segment.types';
import { SEGMENTATION_CONFIG } from './segment.types';

const SCENE_MARKER_PATTERN = /^(?:\*{3,}|-{3,}|#{1,3}\s+.+)$/m;
const SCREENPLAY_MARKER_PATTERN = /^(?:INT\.|EXT\.|FADE\s+(?:IN|OUT|TO))/m;
const DOUBLE_NEWLINE_PATTERN = /\n\s*\n/g;

/**
 * Detect all potential segment boundaries in text.
 * Returns boundaries sorted by position.
 */
export function detectBoundaries(text: string): SegmentBoundary[] {
  const boundaries: SegmentBoundary[] = [];

  let match: RegExpExecArray | null;

  // Double newlines (paragraph breaks)
  const doubleNewlineRegex = new RegExp(DOUBLE_NEWLINE_PATTERN.source, 'g');
  while ((match = doubleNewlineRegex.exec(text)) !== null) {
    boundaries.push({
      position: match.index + match[0].length,
      type: 'double_newline',
    });
  }

  // Scene markers (***, ---, # Chapter)
  const lines = text.split('\n');
  let charOffset = 0;
  for (const line of lines) {
    if (
      SCENE_MARKER_PATTERN.test(line.trim()) ||
      SCREENPLAY_MARKER_PATTERN.test(line.trim())
    ) {
      boundaries.push({
        position: charOffset,
        type: 'scene_marker',
      });
    }
    charOffset += line.length + 1;
  }

  return boundaries.sort((a, b) => a.position - b.position);
}

/**
 * Filter boundaries to respect size constraints.
 * Keeps boundaries that create segments within target size range.
 */
export function filterBoundariesBySize(
  boundaries: SegmentBoundary[],
  _textLength: number,
): SegmentBoundary[] {
  const { TARGET_MIN_SIZE } = SEGMENTATION_CONFIG;
  const filtered: SegmentBoundary[] = [];
  let lastPosition = 0;

  for (const boundary of boundaries) {
    const segmentSize = boundary.position - lastPosition;

    if (segmentSize >= TARGET_MIN_SIZE) {
      filtered.push(boundary);
      lastPosition = boundary.position;
    }
  }

  return filtered;
}

/**
 * Insert size-based splits for segments that exceed max size.
 * Tries to split at word boundaries.
 */
export function insertSizeSplits(
  boundaries: SegmentBoundary[],
  text: string,
): SegmentBoundary[] {
  const { HARD_MAX_SIZE } = SEGMENTATION_CONFIG;
  const result: SegmentBoundary[] = [];
  let lastPosition = 0;

  for (const boundary of boundaries) {
    const segmentSize = boundary.position - lastPosition;

    if (segmentSize > HARD_MAX_SIZE) {
      const splits = splitOversizedSegment(
        text,
        lastPosition,
        boundary.position,
      );
      result.push(...splits);
    }

    result.push(boundary);
    lastPosition = boundary.position;
  }

  // Handle final segment
  const finalSize = text.length - lastPosition;
  if (finalSize > HARD_MAX_SIZE) {
    const splits = splitOversizedSegment(text, lastPosition, text.length);
    result.push(...splits);
  }

  return result.sort((a, b) => a.position - b.position);
}

/**
 * Split an oversized region at word boundaries.
 */
function splitOversizedSegment(
  text: string,
  start: number,
  end: number,
): SegmentBoundary[] {
  const { TARGET_MAX_SIZE } = SEGMENTATION_CONFIG;
  const splits: SegmentBoundary[] = [];
  let position = start;

  while (end - position > TARGET_MAX_SIZE) {
    const targetSplit = position + TARGET_MAX_SIZE;
    const splitPos = findWordBoundary(text, targetSplit, position, end);

    splits.push({
      position: splitPos,
      type: 'size_split',
    });

    position = splitPos;
  }

  return splits;
}

/**
 * Find nearest word boundary to target position.
 */
function findWordBoundary(
  text: string,
  target: number,
  min: number,
  max: number,
): number {
  const searchRange = 200;
  const searchStart = Math.max(min, target - searchRange);
  const searchEnd = Math.min(max, target + searchRange);

  // Look for whitespace near target
  for (let i = target; i < searchEnd; i++) {
    if (/\s/.test(text[i])) {
      return i + 1;
    }
  }

  for (let i = target; i > searchStart; i--) {
    if (/\s/.test(text[i])) {
      return i + 1;
    }
  }

  return target;
}

/**
 * Convert boundaries to segments with stable UUIDs.
 * Uses similarity matching to preserve UUIDs across document edits.
 */
export function boundariesToSegments(
  boundaries: SegmentBoundary[],
  textLength: number,
  text: string,
  existingSegments?: Segment[],
): Segment[] {
  const segments: Segment[] = [];
  const usedIds = new Set<string>();
  let lastPosition = 0;

  for (const boundary of boundaries) {
    if (boundary.position > lastPosition) {
      const start = lastPosition;
      const end = boundary.position;
      const content = text.slice(start, end);

      const matchedSegment = findBestSegmentMatch(
        { start, end },
        content,
        text,
        existingSegments,
        usedIds,
      );

      const id = matchedSegment?.id || randomUUID();
      if (matchedSegment) {
        usedIds.add(id);
      }

      segments.push({ id, start, end });
    }
    lastPosition = boundary.position;
  }

  // Final segment
  if (lastPosition < textLength) {
    const content = text.slice(lastPosition, textLength);
    const matchedSegment = findBestSegmentMatch(
      { start: lastPosition, end: textLength },
      content,
      text,
      existingSegments,
      usedIds,
    );

    const id = matchedSegment?.id || randomUUID();
    if (matchedSegment) {
      usedIds.add(id);
    }

    segments.push({ id, start: lastPosition, end: textLength });
  }

  return segments;
}

/**
 * Find best matching existing segment using position overlap and content similarity.
 */
function findBestSegmentMatch(
  newRange: { start: number; end: number },
  newContent: string,
  fullText: string,
  existingSegments?: Segment[],
  usedIds?: Set<string>,
): Segment | null {
  if (!existingSegments?.length) return null;

  let bestMatch: Segment | null = null;
  let bestScore = 0;

  for (const existing of existingSegments) {
    // Skip if UUID already used
    if (usedIds?.has(existing.id)) continue;

    // Extract old content from current text at old position
    // (This works if text hasn't changed much; for major changes, would need old text)
    const oldContent = fullText.slice(
      existing.start,
      Math.min(existing.end, fullText.length),
    );

    const score = calculateSegmentSimilarity(
      newRange,
      newContent,
      existing,
      oldContent,
    );

    // Threshold: 0.7 = significant overlap/similarity
    if (score > bestScore && score >= 0.7) {
      bestScore = score;
      bestMatch = existing;
    }
  }

  return bestMatch;
}

/**
 * Calculate similarity score between new and existing segment.
 * Returns 0-1 score based on position overlap, size, and content.
 */
function calculateSegmentSimilarity(
  newRange: { start: number; end: number },
  newContent: string,
  existing: Segment,
  oldContent: string,
): number {
  // 1. Position overlap
  const overlap = calculateRangeOverlap(newRange, existing);
  const maxSize = Math.max(
    newRange.end - newRange.start,
    existing.end - existing.start,
  );
  const positionScore = overlap / maxSize;

  // 2. Size similarity
  const newSize = newRange.end - newRange.start;
  const oldSize = existing.end - existing.start;
  const sizeScore =
    1 - Math.abs(newSize - oldSize) / Math.max(newSize, oldSize);

  // 3. Content similarity (if old content available)
  if (oldContent && oldContent.length > 20) {
    const contentScore = calculateContentSimilarity(newContent, oldContent);
    return positionScore * 0.4 + sizeScore * 0.2 + contentScore * 0.4;
  }

  // Without content: position 60%, size 40%
  return positionScore * 0.6 + sizeScore * 0.4;
}

/**
 * Calculate overlap between two ranges.
 */
function calculateRangeOverlap(
  range1: { start: number; end: number },
  range2: { start: number; end: number },
): number {
  const overlapStart = Math.max(range1.start, range2.start);
  const overlapEnd = Math.min(range1.end, range2.end);
  return Math.max(0, overlapEnd - overlapStart);
}

/**
 * Calculate content similarity using fingerprint (head + tail).
 */
function calculateContentSimilarity(text1: string, text2: string): number {
  const fp1 = getContentFingerprint(text1);
  const fp2 = getContentFingerprint(text2);

  const headSim = calculateWordOverlap(fp1.head, fp2.head);
  const tailSim = calculateWordOverlap(fp1.tail, fp2.tail);

  return (headSim + tailSim) / 2;
}

/**
 * Get fingerprint of text (first and last 200 chars).
 */
function getContentFingerprint(text: string): { head: string; tail: string } {
  const len = 200;
  return {
    head: text.slice(0, len),
    tail: text.slice(-len),
  };
}

/**
 * Calculate word overlap between two text snippets.
 */
function calculateWordOverlap(text1: string, text2: string): number {
  const words1 = new Set(
    text1
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const words2 = new Set(
    text2
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  return intersection.size / Math.max(words1.size, words2.size);
}

/**
 * Main segmentation function.
 * Returns segments with stable UUIDs, reusing existing IDs where positions match.
 */
export function segmentText(
  text: string,
  existingSegments?: Segment[],
): SegmentationResult {
  const { MIN_DOCUMENT_LENGTH } = SEGMENTATION_CONFIG;

  // Short documents get a single segment
  if (text.length < MIN_DOCUMENT_LENGTH) {
    const existingId = existingSegments?.[0]?.id;
    return {
      segments: [
        {
          id: existingId || randomUUID(),
          start: 0,
          end: text.length,
        },
      ],
      boundaries: [],
    };
  }

  const rawBoundaries = detectBoundaries(text);
  const sizedBoundaries = filterBoundariesBySize(rawBoundaries, text.length);
  const finalBoundaries = insertSizeSplits(sizedBoundaries, text);
  const segments = boundariesToSegments(
    finalBoundaries,
    text.length,
    text,
    existingSegments,
  );

  return { segments, boundaries: finalBoundaries };
}

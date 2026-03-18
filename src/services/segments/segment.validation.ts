/**
 * Segment validation utilities.
 * Validates that segments are consistent with content.
 */

import type { Segment } from './segment.types';

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that segments are consistent with content length.
 * Returns errors for invalid segments.
 */
export function validateSegmentsForContent(
  segments: Segment[],
  contentLength: number,
): ValidationResult {
  const errors: string[] = [];

  // Empty content with no segments is valid
  if (contentLength === 0 && segments.length === 0) {
    return { valid: true, errors: [] };
  }

  // Content exists but no segments
  if (contentLength > 0 && segments.length === 0) {
    errors.push('Document has content but no segments');
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Zero-length or negative range
    if (seg.end <= seg.start) {
      errors.push(`Segment ${i}: invalid range [${seg.start}, ${seg.end}]`);
    }

    // Exceeds content bounds
    if (seg.end > contentLength) {
      errors.push(
        `Segment ${i}: end (${seg.end}) exceeds content length (${contentLength})`,
      );
    }

    // Negative start
    if (seg.start < 0) {
      errors.push(`Segment ${i}: negative start (${seg.start})`);
    }

    // Check for overlap with previous segment
    if (i > 0) {
      const prev = segments[i - 1];
      if (seg.start < prev.end) {
        errors.push(
          `Segment ${i}: overlaps with segment ${i - 1} (${prev.start}-${prev.end} vs ${seg.start}-${seg.end})`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Quick boolean check for valid segments.
 */
export function hasValidSegments(
  segments: Segment[],
  contentLength: number,
): boolean {
  if (contentLength === 0) return true;
  if (segments.length === 0) return false;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // Basic range validation
    if (s.start < 0 || s.end <= s.start || s.end > contentLength) {
      return false;
    }
    // Overlap check
    if (i > 0 && s.start < segments[i - 1].end) {
      return false;
    }
  }
  return true;
}

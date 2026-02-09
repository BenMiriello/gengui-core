/**
 * Types for document segmentation.
 * Segments are stable-UUID sections of documents used for bounded search
 * and position-relative mention anchoring.
 */

export interface Segment {
  id: string;
  start: number;
  end: number;
}

export interface SegmentBoundary {
  position: number;
  type: BoundaryType;
}

export type BoundaryType = 'double_newline' | 'scene_marker' | 'chapter_heading' | 'size_split';

export interface SegmentationResult {
  segments: Segment[];
  boundaries: SegmentBoundary[];
}

export interface SegmentMatch {
  segmentId: string;
  segmentStart: number;
  segmentEnd: number;
}

export const SEGMENTATION_CONFIG = {
  MIN_DOCUMENT_LENGTH: 4000,
  TARGET_MIN_SIZE: 750,
  TARGET_MAX_SIZE: 6000,
  HARD_MAX_SIZE: 8000,
} as const;

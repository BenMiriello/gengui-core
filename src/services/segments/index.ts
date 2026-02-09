/**
 * Segments module - document segmentation for bounded search and mention anchoring.
 */

export { detectBoundaries, segmentText } from './segment.detector';
export { segmentService } from './segment.service';
export type {
  BoundaryType,
  Segment,
  SegmentationResult,
  SegmentBoundary,
  SegmentMatch,
} from './segment.types';
export { SEGMENTATION_CONFIG } from './segment.types';

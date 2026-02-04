/**
 * Segments module - document segmentation for bounded search and mention anchoring.
 */

export { segmentService } from './segment.service';
export { segmentText, detectBoundaries } from './segment.detector';
export type {
  Segment,
  SegmentBoundary,
  SegmentationResult,
  SegmentMatch,
  BoundaryType,
} from './segment.types';
export { SEGMENTATION_CONFIG } from './segment.types';

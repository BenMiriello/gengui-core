import { describe, expect, it } from 'bun:test';
import {
  hasValidSegments,
  validateSegmentsForContent,
} from '../../services/segments';

describe('segment validation', () => {
  describe('validateSegmentsForContent', () => {
    it('passes valid segments', () => {
      const segments = [{ id: '1', start: 0, end: 100 }];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes multiple contiguous segments', () => {
      const segments = [
        { id: '1', start: 0, end: 50 },
        { id: '2', start: 50, end: 100 },
      ];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(true);
    });

    it('fails zero-length segments', () => {
      const segments = [{ id: '1', start: 0, end: 0 }];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid range');
    });

    it('fails negative-length segments', () => {
      const segments = [{ id: '1', start: 50, end: 10 }];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid range');
    });

    it('fails out-of-bounds segments', () => {
      const segments = [{ id: '1', start: 0, end: 200 }];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('exceeds content length');
    });

    it('fails negative start', () => {
      const segments = [{ id: '1', start: -10, end: 50 }];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('negative start');
    });

    it('fails when content exists but no segments', () => {
      const result = validateSegmentsForContent([], 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('no segments');
    });

    it('passes empty content with no segments', () => {
      const result = validateSegmentsForContent([], 0);
      expect(result.valid).toBe(true);
    });

    it('collects multiple errors', () => {
      const segments = [
        { id: '1', start: -5, end: 10 },
        { id: '2', start: 50, end: 50 },
        { id: '3', start: 60, end: 200 },
      ];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('fails overlapping segments', () => {
      const segments = [
        { id: '1', start: 0, end: 60 },
        { id: '2', start: 50, end: 100 },
      ];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('overlaps');
    });

    it('passes non-overlapping segments', () => {
      const segments = [
        { id: '1', start: 0, end: 50 },
        { id: '2', start: 50, end: 100 },
      ];
      const result = validateSegmentsForContent(segments, 100);
      expect(result.valid).toBe(true);
    });
  });

  describe('hasValidSegments', () => {
    it('returns true for valid segments', () => {
      const segments = [{ id: '1', start: 0, end: 100 }];
      expect(hasValidSegments(segments, 100)).toBe(true);
    });

    it('returns false for invalid segments', () => {
      const segments = [{ id: '1', start: 0, end: 0 }];
      expect(hasValidSegments(segments, 100)).toBe(false);
    });

    it('returns true for empty content', () => {
      expect(hasValidSegments([], 0)).toBe(true);
    });

    it('returns false for content without segments', () => {
      expect(hasValidSegments([], 100)).toBe(false);
    });

    it('returns false for overlapping segments', () => {
      const segments = [
        { id: '1', start: 0, end: 60 },
        { id: '2', start: 50, end: 100 },
      ];
      expect(hasValidSegments(segments, 100)).toBe(false);
    });

    it('returns true for non-overlapping segments', () => {
      const segments = [
        { id: '1', start: 0, end: 50 },
        { id: '2', start: 50, end: 100 },
      ];
      expect(hasValidSegments(segments, 100)).toBe(true);
    });
  });
});

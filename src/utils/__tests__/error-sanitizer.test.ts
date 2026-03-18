import { describe, expect, it } from 'bun:test';
import { getErrorForLogging, sanitizeError } from '../error-sanitizer';

describe('sanitizeError', () => {
  describe('user-facing errors', () => {
    it('preserves validation error messages', () => {
      const error = new Error(
        'Document is too short. Please add at least 50 characters of text.',
      );
      expect(sanitizeError(error)).toBe(
        'Document is too short. Please add at least 50 characters of text.',
      );
    });

    it('preserves empty document errors', () => {
      const error = new Error(
        'Document is empty. Please add some text before analyzing.',
      );
      expect(sanitizeError(error)).toBe(
        'Document is empty. Please add some text before analyzing.',
      );
    });

    it('preserves not found errors', () => {
      const error = new Error('Document not found');
      expect(sanitizeError(error)).toBe('Document not found');
    });
  });

  describe('internal errors', () => {
    it('sanitizes module resolution errors', () => {
      const error = new Error(
        "Cannot find module '/Users/dev/voyageai/dist/esm/api/index.jsx'",
      );
      expect(sanitizeError(error)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });

    it('sanitizes stack traces', () => {
      const error = new Error('Something broke');
      error.stack = `Error: Something broke
    at Pipeline.run (/app/src/services/pipeline/pipeline.ts:123:45)
    at DocumentAnalysisWorker.processJob (/app/src/jobs/workers/document-analysis.ts:90:12)`;
      expect(sanitizeError(error)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });

    it('sanitizes service names', () => {
      const error = new Error('Pipeline service failed to initialize');
      expect(sanitizeError(error)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });

    it('sanitizes database column names', () => {
      const error = new Error('column "error_message" does not exist');
      expect(sanitizeError(error)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });
  });

  describe('transient errors', () => {
    it('provides retry message for timeouts', () => {
      const error = new Error('Request timeout after 30 seconds');
      expect(sanitizeError(error)).toBe(
        'The service is temporarily unavailable. Please try again in a moment.',
      );
    });

    it('provides retry message for rate limits', () => {
      const error = new Error('Rate limit exceeded');
      expect(sanitizeError(error)).toBe(
        'The service is temporarily unavailable. Please try again in a moment.',
      );
    });
  });

  describe('mixed content', () => {
    it('sanitizes user error with leaked internal details', () => {
      const error = new Error(
        'Document is too short at /app/src/services/validation.ts:45',
      );
      expect(sanitizeError(error)).toBe(
        'The request could not be completed. Please try again.',
      );
    });
  });

  describe('non-Error objects', () => {
    it('handles string errors', () => {
      expect(sanitizeError('Something went wrong')).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });

    it('handles null/undefined', () => {
      expect(sanitizeError(null)).toBe(
        'Analysis could not be completed. Please try again.',
      );
      expect(sanitizeError(undefined)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });
  });

  describe('prompt augmentation errors', () => {
    it('preserves quota exceeded messages', () => {
      const error = new Error('API quota exceeded. Please try again later.');
      expect(sanitizeError(error)).toBe(
        'The service is temporarily unavailable. Please try again in a moment.',
      );
    });

    it('preserves inappropriate content messages', () => {
      const error = new Error(
        'Unable to augment prompt. The content may contain inappropriate material.',
      );
      expect(sanitizeError(error)).toBe(
        'Unable to augment prompt. The content may contain inappropriate material.',
      );
    });

    it('preserves filtered content messages', () => {
      const error = new Error(
        'Unable to augment prompt. The content may have been filtered. Please try again.',
      );
      expect(sanitizeError(error)).toBe(
        'Unable to augment prompt. The content may have been filtered. Please try again.',
      );
    });
  });

  describe('image generation errors', () => {
    it('preserves timeout messages', () => {
      const error = new Error('Image generation timed out');
      expect(sanitizeError(error)).toBe(
        'The service is temporarily unavailable. Please try again in a moment.',
      );
    });

    it('preserves service unavailable messages', () => {
      const error = new Error('Image generation service unavailable');
      expect(sanitizeError(error)).toBe(
        'Analysis could not be completed. Please try again.',
      );
    });
  });
});

describe('getErrorForLogging', () => {
  it('extracts full error details for logging', () => {
    const error = new Error('Test error');
    error.stack = 'Error: Test error\n    at test.ts:1:1';

    const logged = getErrorForLogging(error);

    expect(logged).toEqual({
      message: 'Test error',
      stack: 'Error: Test error\n    at test.ts:1:1',
      name: 'Error',
    });
  });

  it('handles non-Error objects', () => {
    const logged = getErrorForLogging('string error');

    expect(logged).toEqual({
      message: 'string error',
    });
  });
});

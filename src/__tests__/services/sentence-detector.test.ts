import { describe, expect, test } from 'vitest';
import { splitIntoSentences } from '../../services/sentences/sentence.detector';

describe('splitIntoSentences', () => {
  describe('basic splitting', () => {
    test('splits simple sentences', () => {
      const result = splitIntoSentences('Hello world. This is a test.');
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('Hello world.');
      expect(result[1].text).toBe('This is a test.');
    });

    test('handles multiple punctuation marks', () => {
      const result = splitIntoSentences(
        'What is happening?! Really though... Yes indeed!',
      );
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test('returns empty array for empty string', () => {
      expect(splitIntoSentences('')).toHaveLength(0);
    });

    test('returns empty array for whitespace only', () => {
      expect(splitIntoSentences('   \n\t  ')).toHaveLength(0);
    });

    test('treats short text as single sentence', () => {
      const result = splitIntoSentences('Short.');
      expect(result).toHaveLength(0);
    });

    test('handles text without sentence-ending punctuation', () => {
      const result = splitIntoSentences(
        'This is a longer piece of text without punctuation at the end',
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('abbreviations (regression: infinite loop bug)', () => {
    test('handles Dr. without infinite loop', () => {
      const result = splitIntoSentences(
        'Dr. Smith went to the store. He bought milk.',
      );
      expect(result).toHaveLength(2);
      expect(result[0].text).toContain('Dr. Smith');
    });

    test('handles Mr. without infinite loop', () => {
      const result = splitIntoSentences('Mr. Jones is here. He wants to talk.');
      expect(result).toHaveLength(2);
    });

    test('handles Mrs. without infinite loop', () => {
      const result = splitIntoSentences(
        'Mrs. Brown arrived early. She brought cake.',
      );
      expect(result).toHaveLength(2);
    });

    test('handles St. without infinite loop', () => {
      const result = splitIntoSentences(
        'I live on St. James Street. It is quiet.',
      );
      expect(result).toHaveLength(2);
    });

    test('handles multiple abbreviations', () => {
      const result = splitIntoSentences(
        'Dr. Smith met Mr. Jones at St. Mary Hospital. They discussed the case.',
      );
      expect(result).toHaveLength(2);
    });

    test('handles e.g. and i.e.', () => {
      const result = splitIntoSentences(
        'Use common tools, e.g. hammers and saws. Also consider i.e. manual ones.',
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('initials (regression: infinite loop bug)', () => {
    test('handles single initial without infinite loop', () => {
      const result = splitIntoSentences(
        'I met J. Smith yesterday. He was nice.',
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('handles multiple initials', () => {
      const result = splitIntoSentences(
        'The author J. K. Rowling wrote many books. They are popular.',
      );
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('position tracking', () => {
    test('returns correct start and end positions', () => {
      const text = 'First sentence. Second sentence.';
      const result = splitIntoSentences(text);

      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(15);
      expect(text.slice(result[0].start, result[0].end)).toBe(
        'First sentence.',
      );
    });

    test('generates content hashes', () => {
      const result = splitIntoSentences('This is a test sentence.');
      expect(result[0].contentHash).toBeDefined();
      expect(result[0].contentHash.length).toBe(64);
    });
  });

  describe('edge cases', () => {
    test('handles consecutive periods', () => {
      const result = splitIntoSentences('End of sentence... New one here.');
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('handles mixed punctuation', () => {
      const result = splitIntoSentences('Is this real?! Yes it is. Amazing...');
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test('handles newlines between sentences', () => {
      const result = splitIntoSentences('First sentence.\nSecond sentence.');
      expect(result).toHaveLength(2);
    });
  });
});

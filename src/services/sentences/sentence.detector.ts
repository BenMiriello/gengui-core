/**
 * Sentence detection using regex-based splitting.
 * Handles common abbreviations and edge cases.
 */

import { createHash } from 'node:crypto';
import type { Sentence } from './sentence.types';

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'vs', 'etc', 'i.e', 'e.g', 'cf', 'al', 'vol', 'no', 'pp',
  'inc', 'ltd', 'corp', 'co', 'fig', 'approx', 'dept', 'est',
]);

/**
 * Split text into sentences.
 * Returns sentence boundaries relative to the input text.
 */
export function splitIntoSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];

  if (!text.trim()) {
    return sentences;
  }

  // Sentence-ending punctuation followed by space or end
  const sentenceEndRegex = /([.!?]+)(\s+|$)/g;

  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = sentenceEndRegex.exec(text)) !== null) {
    const punctuationEnd = match.index + match[1].length;

    // Check if this is an abbreviation
    const beforePunctuation = text.slice(lastEnd, match.index);
    const lastWord = beforePunctuation.split(/\s+/).pop()?.toLowerCase() || '';

    if (ABBREVIATIONS.has(lastWord.replace(/\.$/, ''))) {
      continue;
    }

    // Check for initials (single letter followed by period)
    if (/^[A-Z]\.$/.test(lastWord)) {
      continue;
    }

    const sentenceText = text.slice(lastEnd, punctuationEnd).trim();

    if (sentenceText.length >= 10) {
      sentences.push({
        start: lastEnd,
        end: punctuationEnd,
        text: sentenceText,
        contentHash: computeContentHash(sentenceText),
      });
    }

    lastEnd = punctuationEnd;

    // Skip whitespace
    while (lastEnd < text.length && /\s/.test(text[lastEnd])) {
      lastEnd++;
    }
  }

  // Handle remaining text (no sentence-ending punctuation)
  if (lastEnd < text.length) {
    const remainingText = text.slice(lastEnd).trim();
    if (remainingText.length >= 10) {
      sentences.push({
        start: lastEnd,
        end: text.length,
        text: remainingText,
        contentHash: computeContentHash(remainingText),
      });
    }
  }

  // If no sentences found, treat entire text as one sentence
  if (sentences.length === 0 && text.trim().length >= 10) {
    sentences.push({
      start: 0,
      end: text.length,
      text: text.trim(),
      contentHash: computeContentHash(text.trim()),
    });
  }

  return sentences;
}

/**
 * Compute SHA-256 hash of content for caching.
 */
export function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

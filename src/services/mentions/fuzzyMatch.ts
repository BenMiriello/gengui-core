/**
 * Two-stage fuzzy matching for relocating text spans in modified documents.
 *
 * Stage 1: Cheap candidate filtering (word/trigram overlap)
 * Stage 2: Levenshtein refinement for survivors
 */

import { distance as levenshteinDistance } from 'fastest-levenshtein';
import type { Segment } from '../segments';
import { segmentService } from '../segments';

export interface FuzzyMatchResult {
  start: number;
  end: number;
  confidence: number;
}

export interface FuzzyMatchInput {
  sourceText: string;
  originalStart: number;
  originalEnd: number;
}

interface Candidate {
  position: number;
  windowText: string;
}

/**
 * Find text in document using two-stage fuzzy matching.
 * Returns null if no match found with confidence >= 0.5
 */
export function fuzzyFindText(
  content: string,
  input: FuzzyMatchInput,
): FuzzyMatchResult | null {
  const { sourceText, originalStart, originalEnd } = input;

  if (!sourceText) return null;

  // Try exact match at original position first
  const exactAtPosition = content.substring(originalStart, originalEnd);
  if (exactAtPosition === sourceText) {
    return { start: originalStart, end: originalEnd, confidence: 1.0 };
  }

  // Try exact match anywhere
  const exactIndex = content.indexOf(sourceText);
  if (exactIndex !== -1) {
    return {
      start: exactIndex,
      end: exactIndex + sourceText.length,
      confidence: 1.0,
    };
  }

  // Two-stage fuzzy matching
  return findWithTwoStage(content, input);
}

/**
 * Find text within a specific segment first, then expand search.
 * More efficient for large documents.
 */
export function fuzzyFindTextInSegment(
  content: string,
  input: FuzzyMatchInput,
  segments: Segment[],
  segmentId: string,
): FuzzyMatchResult | null {
  const segment = segmentService.getSegmentById(segments, segmentId);

  if (segment) {
    // Search within segment first
    const segmentContent = content.slice(segment.start, segment.end);
    const localResult = fuzzyFindText(segmentContent, {
      sourceText: input.sourceText,
      originalStart: input.originalStart - segment.start,
      originalEnd: input.originalEnd - segment.start,
    });

    if (localResult && localResult.confidence >= 0.7) {
      return {
        start: segment.start + localResult.start,
        end: segment.start + localResult.end,
        confidence: localResult.confidence,
      };
    }
  }

  // Fall back to full document search
  return fuzzyFindText(content, input);
}

function findWithTwoStage(
  content: string,
  input: FuzzyMatchInput,
): FuzzyMatchResult | null {
  const { sourceText, originalStart } = input;
  const anchorLength = sourceText.length;

  // Pre-compute anchor data
  const anchorWords = extractWords(sourceText);
  const anchorTrigrams = extractTrigrams(sourceText);

  // Calculate stride and window size
  const stride = Math.max(1, Math.floor(anchorLength / 3));
  const windowSize = Math.floor(anchorLength * 1.3);

  // Stage 1: Filter candidates
  const candidates: Candidate[] = [];

  for (
    let position = 0;
    position < content.length - anchorLength / 2;
    position += stride
  ) {
    const windowEnd = Math.min(content.length, position + windowSize);
    const windowText = content.substring(position, windowEnd);

    // Check for exact match in window
    if (windowText.startsWith(sourceText)) {
      return { start: position, end: position + anchorLength, confidence: 1.0 };
    }

    // Filter 1: Word overlap (30% threshold)
    const wordOverlap = calculateWordOverlap(anchorWords, windowText);
    if (wordOverlap < 0.3) continue;

    // Filter 2: Trigram overlap (30% threshold)
    const trigramOverlap = calculateTrigramOverlap(anchorTrigrams, windowText);
    if (trigramOverlap < 0.3) continue;

    candidates.push({ position, windowText });
  }

  if (candidates.length === 0) {
    return null;
  }

  // Stage 2: Refine candidates with Levenshtein
  let bestMatch: FuzzyMatchResult | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candidateText = candidate.windowText.substring(0, anchorLength);
    const levenshteinScore = calculateLevenshteinSimilarity(
      sourceText,
      candidateText,
    );

    if (levenshteinScore >= 1.0) {
      return {
        start: candidate.position,
        end: candidate.position + anchorLength,
        confidence: 1.0,
      };
    }

    if (levenshteinScore > bestScore) {
      bestScore = levenshteinScore;
      bestMatch = {
        start: candidate.position,
        end: candidate.position + anchorLength,
        confidence: levenshteinScore,
      };
    }
  }

  if (!bestMatch || bestScore < 0.5) {
    return null;
  }

  // Tiebreaking for borderline matches (0.5-0.7)
  if (bestScore < 0.7 && candidates.length > 1) {
    const viableCandidates = candidates.filter((c) => {
      const candidateText = c.windowText.substring(0, anchorLength);
      return calculateLevenshteinSimilarity(sourceText, candidateText) >= 0.5;
    });

    if (viableCandidates.length > 1) {
      let bestFinalScore = 0;
      let bestFinalMatch: FuzzyMatchResult | null = null;

      for (const candidate of viableCandidates) {
        const candidateText = candidate.windowText.substring(0, anchorLength);
        const levenshteinScore = calculateLevenshteinSimilarity(
          sourceText,
          candidateText,
        );
        const proximityScore = calculateProximityScore(
          candidate.position,
          originalStart,
        );

        // 70% Levenshtein, 30% proximity (simplified from frontend version)
        const finalScore = levenshteinScore * 0.7 + proximityScore * 0.3;

        if (finalScore > bestFinalScore) {
          bestFinalScore = finalScore;
          bestFinalMatch = {
            start: candidate.position,
            end: candidate.position + anchorLength,
            confidence: finalScore,
          };
        }
      }

      return bestFinalMatch;
    }
  }

  return bestMatch;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

function extractTrigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const trigrams = new Set<string>();

  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }

  return trigrams;
}

function calculateWordOverlap(
  anchorWords: Set<string>,
  windowText: string,
): number {
  const windowWords = new Set(
    windowText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );

  let matchCount = 0;
  for (const word of anchorWords) {
    if (windowWords.has(word)) {
      matchCount++;
    }
  }

  return anchorWords.size > 0 ? matchCount / anchorWords.size : 0;
}

function calculateTrigramOverlap(
  anchorTrigrams: Set<string>,
  windowText: string,
): number {
  if (anchorTrigrams.size === 0) return 1.0;

  const windowTrigrams = extractTrigrams(windowText);

  let matchCount = 0;
  for (const trigram of anchorTrigrams) {
    if (windowTrigrams.has(trigram)) {
      matchCount++;
    }
  }

  return matchCount / anchorTrigrams.size;
}

function calculateLevenshteinSimilarity(str1: string, str2: string): number {
  const dist = levenshteinDistance(str1, str2);
  const maxLen = Math.max(str1.length, str2.length);
  return maxLen > 0 ? 1 - dist / maxLen : 1.0;
}

function calculateProximityScore(
  currentPosition: number,
  originalPosition: number,
): number {
  const distance = Math.abs(currentPosition - originalPosition);
  return Math.exp(-distance / 1000);
}

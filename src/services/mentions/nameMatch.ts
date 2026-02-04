/**
 * Name matching for comprehensive mention detection.
 * Finds all occurrences of entity names/aliases in document text.
 * Creates mentions with source: 'name_match' and lower confidence.
 */

import { segmentService, type Segment } from '../segments';
import type { CreateMentionInput } from './mention.types';

export interface NameMatchConfig {
  caseSensitive?: boolean;
  minConfidence?: number;
  excludeExistingSpans?: Array<{ start: number; end: number }>;
}

export interface NameMatchResult {
  start: number;
  end: number;
  matchedText: string;
  confidence: number;
}

/**
 * Find all occurrences of a name (and aliases) in text.
 * Returns absolute positions.
 */
export function findNameOccurrences(
  content: string,
  name: string,
  aliases: string[] = [],
  config: NameMatchConfig = {}
): NameMatchResult[] {
  const {
    caseSensitive = false,
    minConfidence = 70,
    excludeExistingSpans = [],
  } = config;

  const results: NameMatchResult[] = [];
  const searchTerms = [name, ...aliases].filter(t => t && t.length > 0);

  for (const term of searchTerms) {
    const matches = findAllMatches(content, term, caseSensitive);

    for (const match of matches) {
      // Skip if overlaps with excluded span
      if (isOverlapping(match, excludeExistingSpans)) {
        continue;
      }

      // Calculate confidence based on match quality
      const confidence = calculateMatchConfidence(term, match.matchedText, name);

      if (confidence >= minConfidence) {
        results.push({
          ...match,
          confidence,
        });
      }
    }
  }

  // Deduplicate overlapping matches, keeping highest confidence
  return deduplicateMatches(results);
}

/**
 * Convert name match results to mention inputs.
 */
export function nameMatchesToMentionInputs(
  nodeId: string,
  documentId: string,
  matches: NameMatchResult[],
  segments: Segment[],
  versionNumber: number
): CreateMentionInput[] {
  const inputs: CreateMentionInput[] = [];

  for (const match of matches) {
    const relative = segmentService.toRelativePosition(
      segments,
      match.start,
      match.end
    );

    if (!relative) continue;

    inputs.push({
      nodeId,
      documentId,
      segmentId: relative.segmentId,
      relativeStart: relative.relativeStart,
      relativeEnd: relative.relativeEnd,
      originalText: match.matchedText,
      versionNumber,
      source: 'name_match',
      confidence: match.confidence,
    });
  }

  return inputs;
}

function findAllMatches(
  content: string,
  term: string,
  caseSensitive: boolean
): Array<{ start: number; end: number; matchedText: string }> {
  const matches: Array<{ start: number; end: number; matchedText: string }> = [];

  if (!term || term.length === 0) return matches;

  // Build regex with word boundaries for better matching
  const escapedTerm = escapeRegex(term);
  const flags = caseSensitive ? 'g' : 'gi';

  // Use word boundary for terms that start/end with word characters
  const startsWithWord = /^\w/.test(term);
  const endsWithWord = /\w$/.test(term);
  const pattern = `${startsWithWord ? '\\b' : ''}${escapedTerm}${endsWithWord ? '\\b' : ''}`;

  try {
    const regex = new RegExp(pattern, flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        matchedText: match[0],
      });

      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }
  } catch {
    // Fallback to simple indexOf if regex fails
    const searchContent = caseSensitive ? content : content.toLowerCase();
    const searchTerm = caseSensitive ? term : term.toLowerCase();

    let index = 0;
    while ((index = searchContent.indexOf(searchTerm, index)) !== -1) {
      matches.push({
        start: index,
        end: index + term.length,
        matchedText: content.slice(index, index + term.length),
      });
      index += term.length;
    }
  }

  return matches;
}

function calculateMatchConfidence(
  searchTerm: string,
  matchedText: string,
  primaryName: string
): number {
  // Exact match with primary name = highest confidence
  if (matchedText.toLowerCase() === primaryName.toLowerCase()) {
    return 95;
  }

  // Exact match with alias
  if (matchedText.toLowerCase() === searchTerm.toLowerCase()) {
    return 85;
  }

  // Case matches exactly
  if (matchedText === searchTerm) {
    return 90;
  }

  // Default for case-insensitive alias match
  return 75;
}

function isOverlapping(
  match: { start: number; end: number },
  excludedSpans: Array<{ start: number; end: number }>
): boolean {
  for (const span of excludedSpans) {
    if (match.start < span.end && match.end > span.start) {
      return true;
    }
  }
  return false;
}

function deduplicateMatches(matches: NameMatchResult[]): NameMatchResult[] {
  if (matches.length <= 1) return matches;

  // Sort by start position, then by confidence (descending)
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.confidence - a.confidence;
  });

  const result: NameMatchResult[] = [];
  let lastEnd = -1;

  for (const match of sorted) {
    // Skip if this match starts before the last one ended
    if (match.start < lastEnd) {
      continue;
    }

    result.push(match);
    lastEnd = match.end;
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

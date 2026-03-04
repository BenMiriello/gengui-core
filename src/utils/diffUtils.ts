/**
 * Unified diff utilities for progressive updates.
 *
 * Per TDD 2026-02-21 Section 10:
 * - Unified diff format has 61% success rate vs 20% for search/replace
 * - 3X reduction in "lazy" modifications
 * - Works well with streaming
 */

import { logger } from './logger';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  isValid: boolean;
}

/**
 * Apply a unified diff to original text.
 * Handles:
 * - Single and multi-hunk diffs
 * - Code block wrappers (```diff ... ```)
 * - Context lines and add/remove operations
 * - Edge cases: empty original, malformed diffs
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  // Handle empty original
  if (!original && !diff) return '';

  const cleanDiff = extractDiffContent(diff);
  if (!cleanDiff) {
    return original;
  }

  const parsed = parseDiff(cleanDiff);
  if (!parsed.isValid || parsed.hunks.length === 0) {
    logger.warn({ diff: cleanDiff.slice(0, 200) }, 'Invalid diff format');
    return original;
  }

  const lines = original ? original.split('\n') : [];
  const result: string[] = [];
  let lineIndex = 0;

  for (const hunk of parsed.hunks) {
    // Validate hunk start position
    const targetLine = hunk.oldStart - 1; // Convert to 0-indexed
    if (targetLine < 0) {
      logger.warn({ hunk }, 'Invalid hunk start position');
      continue;
    }

    // Copy unchanged lines up to hunk start
    while (lineIndex < targetLine && lineIndex < lines.length) {
      result.push(lines[lineIndex]);
      lineIndex++;
    }

    // Process hunk lines
    for (const hunkLine of hunk.lines) {
      if (hunkLine.startsWith('-')) {
        // Remove line - verify it matches and skip
        const expectedContent = hunkLine.slice(1);
        if (lineIndex < lines.length) {
          const actualContent = lines[lineIndex];
          // Allow some whitespace flexibility but log mismatches
          if (actualContent.trim() !== expectedContent.trim()) {
            logger.debug(
              {
                expected: expectedContent.slice(0, 50),
                actual: actualContent.slice(0, 50),
                lineIndex,
              },
              'Diff line mismatch (applying anyway)',
            );
          }
          lineIndex++;
        }
      } else if (hunkLine.startsWith('+')) {
        // Add line
        result.push(hunkLine.slice(1));
      } else if (hunkLine.startsWith(' ') || hunkLine === '') {
        // Context line - copy from original and advance
        if (lineIndex < lines.length) {
          result.push(lines[lineIndex]);
          lineIndex++;
        } else {
          // Past end of original, use context from diff
          result.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : '');
        }
      }
    }
  }

  // Copy remaining lines after last hunk
  while (lineIndex < lines.length) {
    result.push(lines[lineIndex]);
    lineIndex++;
  }

  return result.join('\n');
}

/**
 * Extract diff content from LLM response.
 * Handles code blocks and raw diff content.
 */
export function extractDiffContent(response: string): string | null {
  if (!response) return null;

  const trimmed = response.trim();

  // Check for diff code block
  const diffBlockMatch = trimmed.match(/```diff\s*([\s\S]*?)\s*```/);
  if (diffBlockMatch) {
    return diffBlockMatch[1].trim();
  }

  // Check for generic code block
  const codeBlockMatch = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Return raw if it looks like a diff
  if (isValidDiff(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Check if text is a valid unified diff.
 */
export function isValidDiff(text: string): boolean {
  if (!text) return false;

  const trimmed = text.trim();

  // Must have hunk header OR diff-style lines
  const hasHunkHeader = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(trimmed);
  const hasDiffLines =
    trimmed.includes('\n-') &&
    trimmed.includes('\n+') &&
    !trimmed.startsWith('-') && // Avoid matching negative numbers
    !trimmed.startsWith('+'); // Avoid matching positive context

  return hasHunkHeader || hasDiffLines;
}

/**
 * Parse a unified diff into structured hunks.
 */
export function parseDiff(diff: string): ParsedDiff {
  const lines = diff.split('\n');
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // Match hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (hunkMatch) {
      // Save previous hunk if exists
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] || '1', 10),
        lines: [],
      };
    } else if (currentHunk) {
      // Add line to current hunk
      if (
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith(' ') ||
        line === ''
      ) {
        currentHunk.lines.push(line);
      }
    }
  }

  // Don't forget last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return {
    hunks,
    isValid: hunks.length > 0,
  };
}

/**
 * Compute a unified diff between two texts.
 * Uses a proper diff algorithm with context lines.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  contextLines: number = 3,
): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Use Myers diff algorithm for optimal diff
  const operations = computeEditScript(oldLines, newLines);

  if (operations.length === 0) {
    return '';
  }

  // Group operations into hunks
  const hunks = groupIntoHunks(oldLines, newLines, operations, contextLines);

  if (hunks.length === 0) {
    return '';
  }

  // Format as unified diff
  return formatUnifiedDiff(hunks);
}

interface EditOperation {
  type: 'equal' | 'delete' | 'insert';
  oldIndex: number;
  newIndex: number;
  oldLine?: string;
  newLine?: string;
}

/**
 * Compute edit script using a simplified Myers-like algorithm.
 * Returns sequence of operations to transform oldLines to newLines.
 */
function computeEditScript(
  oldLines: string[],
  newLines: string[],
): EditOperation[] {
  const operations: EditOperation[] = [];

  // Build LCS table for better diff quality
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (
      lcsIdx < lcs.length &&
      oldIdx < oldLines.length &&
      newIdx < newLines.length &&
      oldLines[oldIdx] === lcs[lcsIdx] &&
      newLines[newIdx] === lcs[lcsIdx]
    ) {
      // Match - equal line
      operations.push({
        type: 'equal',
        oldIndex: oldIdx,
        newIndex: newIdx,
        oldLine: oldLines[oldIdx],
      });
      oldIdx++;
      newIdx++;
      lcsIdx++;
    } else if (
      oldIdx < oldLines.length &&
      (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])
    ) {
      // Delete from old
      operations.push({
        type: 'delete',
        oldIndex: oldIdx,
        newIndex: newIdx,
        oldLine: oldLines[oldIdx],
      });
      oldIdx++;
    } else if (
      newIdx < newLines.length &&
      (lcsIdx >= lcs.length || newLines[newIdx] !== lcs[lcsIdx])
    ) {
      // Insert into new
      operations.push({
        type: 'insert',
        oldIndex: oldIdx,
        newIndex: newIdx,
        newLine: newLines[newIdx],
      });
      newIdx++;
    }
  }

  return operations;
}

/**
 * Compute Longest Common Subsequence of two line arrays.
 */
function computeLCS(oldLines: string[], newLines: string[]): string[] {
  const m = oldLines.length;
  const n = newLines.length;

  // DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift(oldLines[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

interface DiffHunkForFormat {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Group edit operations into hunks with context.
 */
function groupIntoHunks(
  _oldLines: string[],
  _newLines: string[],
  operations: EditOperation[],
  contextLines: number,
): DiffHunkForFormat[] {
  const hunks: DiffHunkForFormat[] = [];
  let currentHunk: DiffHunkForFormat | null = null;
  let lastChangeIdx = -1;
  let lastAddedIdx = -1;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (op.type !== 'equal') {
      // This is a change
      if (!currentHunk || i - lastChangeIdx > contextLines * 2) {
        // Start new hunk
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        // Include leading context
        const contextStart = Math.max(0, i - contextLines);
        currentHunk = {
          oldStart: operations[contextStart]?.oldIndex + 1 || 1,
          oldCount: 0,
          newStart: operations[contextStart]?.newIndex + 1 || 1,
          newCount: 0,
          lines: [],
        };

        // Add leading context lines
        for (let j = contextStart; j < i; j++) {
          const ctxOp = operations[j];
          if (ctxOp.type === 'equal' && ctxOp.oldLine !== undefined) {
            currentHunk.lines.push(` ${ctxOp.oldLine}`);
            currentHunk.oldCount++;
            currentHunk.newCount++;
          }
        }
        lastAddedIdx = i - 1;
      } else {
        // Changes close enough to merge - add any missing context lines between
        for (let j = lastAddedIdx + 1; j < i; j++) {
          const ctxOp = operations[j];
          if (ctxOp.type === 'equal' && ctxOp.oldLine !== undefined) {
            currentHunk.lines.push(` ${ctxOp.oldLine}`);
            currentHunk.oldCount++;
            currentHunk.newCount++;
          }
        }
      }

      // Add the change
      if (op.type === 'delete' && op.oldLine !== undefined) {
        currentHunk.lines.push(`-${op.oldLine}`);
        currentHunk.oldCount++;
      } else if (op.type === 'insert' && op.newLine !== undefined) {
        currentHunk.lines.push(`+${op.newLine}`);
        currentHunk.newCount++;
      }

      lastChangeIdx = i;
      lastAddedIdx = i;
    } else if (currentHunk && i - lastChangeIdx <= contextLines) {
      // Trailing context within range
      if (op.oldLine !== undefined) {
        currentHunk.lines.push(` ${op.oldLine}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
        lastAddedIdx = i;
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Format hunks as unified diff string.
 */
function formatUnifiedDiff(hunks: DiffHunkForFormat[]): string {
  const parts: string[] = [];

  for (const hunk of hunks) {
    // Hunk header
    const oldRange =
      hunk.oldCount === 1
        ? `${hunk.oldStart}`
        : `${hunk.oldStart},${hunk.oldCount}`;
    const newRange =
      hunk.newCount === 1
        ? `${hunk.newStart}`
        : `${hunk.newStart},${hunk.newCount}`;

    parts.push(`@@ -${oldRange} +${newRange} @@`);
    parts.push(...hunk.lines);
  }

  return parts.join('\n');
}

/**
 * Invert a unified diff (swap + and - lines).
 * Used for reconstructing historical versions.
 */
export function invertDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `-${line.slice(1)}`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `+${line.slice(1)}`;
      }
      // Swap line counts in hunk headers
      const hunkMatch = line.match(
        /^(@@ )-(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) (@@.*)$/,
      );
      if (hunkMatch) {
        return `${hunkMatch[1]}-${hunkMatch[3]} +${hunkMatch[2]} ${hunkMatch[4]}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Check if diff has significant changes worth updating.
 */
export function hasSignificantChanges(
  diff: string,
  minChanges: number = 3,
): boolean {
  if (!diff || diff.trim() === '') {
    return false;
  }

  const lines = diff.split('\n');
  const changes = lines.filter(
    (l) =>
      (l.startsWith('+') && !l.startsWith('+++')) ||
      (l.startsWith('-') && !l.startsWith('---')),
  ).length;

  return changes >= minChanges;
}

/**
 * Summarization Service
 *
 * Progressive update system for summaries using unified diff format.
 * Applies to document summaries, chapter summaries, thread summaries, etc.
 *
 * Per TDD 2026-02-21 Section 10:
 * - Unified diff format (61% success vs 20% search/replace)
 * - NO_CHANGE support to avoid unnecessary updates
 * - Edit chain tracking with forced regeneration at N=10
 * - Store current version full, history as deltas
 */

import {
  BATCH_CONFIG,
  CONFLICT_CONFIG,
  EDIT_CHAIN_CONFIG,
} from '../../utils/constants';
import {
  applyUnifiedDiff,
  computeDiff,
  extractDiffContent,
  hasSignificantChanges,
  invertDiff,
  isValidDiff,
} from '../../utils/diffUtils';
import { isNoChangeResponse } from '../../utils/llmUtils';
import { logger } from '../../utils/logger';
import { getGeminiClient } from '../gemini/core';

export type SummaryType = 'document' | 'chapter' | 'section' | 'thread' | 'arc';

export interface SummaryInput {
  summaryId: string;
  summaryType: SummaryType;
  sourceText: string;
  currentSummary?: string;
  editChainLength?: number;
  context?: string;
}

export interface SummaryUpdateInput {
  summaryId: string;
  summaryType: SummaryType;
  currentSummary: string;
  sourceDiff: string;
  editChainLength: number;
  context?: string;
}

export interface SummaryResult {
  summaryId: string;
  summary: string;
  method: 'initial' | 'edit' | 'regenerate' | 'no_change';
  diff?: string;
  editChainLength: number;
}

export interface SummaryVersion {
  id: string;
  summaryId: string;
  versionNumber: number;
  content: string | null;
  deltaFromVersion?: number;
  delta?: string;
  sourceVersionId: string;
  editChainLength: number;
  createdAt: Date;
  method: 'initial' | 'edit' | 'regenerate';
}

/**
 * Build prompt for initial summary generation.
 */
function buildGenerationPrompt(
  summaryType: SummaryType,
  sourceText: string,
  context?: string,
): string {
  const typeGuidelines: Record<SummaryType, string> = {
    document: `Summarize the entire document, covering:
- Main themes and topics
- Key events or arguments
- Important characters, entities, or concepts
- Overall narrative arc or structure`,
    chapter: `Summarize this chapter/section, covering:
- What happens in this section
- Key character actions and decisions
- Plot developments or arguments made
- Connection to broader narrative`,
    section: `Summarize this section briefly:
- Main point or event
- Key details worth remembering
- Significance to larger context`,
    thread: `Summarize this narrative thread:
- What the thread tracks (character arc, subplot, theme)
- Key events in the thread
- Current state and trajectory`,
    arc: `Summarize this character/story arc:
- Starting point and current state
- Key transformation events
- Themes and meaning`,
  };

  return `## TASK
Generate a concise summary of the provided ${summaryType}.

## GUIDELINES
${typeGuidelines[summaryType]}

## LENGTH
- Keep summary to 100-300 words depending on source complexity
- Prioritize clarity over completeness
- Use present tense for narrative content

${context ? `## CONTEXT\n${context}\n` : ''}
## SOURCE TEXT
${sourceText}

## OUTPUT
Write the summary directly. No JSON formatting needed.`;
}

/**
 * Build prompt for progressive summary update using unified diff.
 */
function buildUpdatePrompt(
  summaryType: SummaryType,
  currentSummary: string,
  sourceDiff: string,
  context?: string,
): string {
  return `## TASK
Update the ${summaryType} summary based on changes to source text.
Generate ONLY necessary changes as unified diff format.

## CURRENT SUMMARY
${currentSummary}

## SOURCE CHANGES (unified diff showing what changed)
${sourceDiff}

${context ? `## CONTEXT\n${context}\n` : ''}

## OUTPUT FORMAT
If changes needed, output unified diff:
\`\`\`diff
@@ -1,3 +1,3 @@
 unchanged line
-removed line
+added line
 unchanged line
\`\`\`

If NO significant change needed, output exactly: NO_CHANGE

## RULES
1. Change only what's necessary to reflect the source changes
2. Preserve the summary's existing style and structure
3. Do not add information not warranted by the changes
4. Do not remove information unless the source removed it
5. Keep the summary concise (100-300 words)`;
}

/**
 * Generate extractive fallback summary when LLM unavailable.
 */
function generateExtractiveFallback(sourceText: string): string {
  const sentences = sourceText.match(/[^.!?]+[.!?]+/g) || [];
  const extractive = sentences
    .slice(0, BATCH_CONFIG.extractiveFallbackSentences)
    .join(' ')
    .trim();
  return (
    extractive || sourceText.slice(0, BATCH_CONFIG.extractiveFallbackChars)
  );
}

export const summaryService = {
  /**
   * Generate a summary from source text.
   * Used for initial generation or forced regeneration.
   */
  async generate(input: SummaryInput): Promise<SummaryResult> {
    const { summaryId, summaryType, sourceText, context } = input;

    const client = await getGeminiClient();
    if (!client) {
      return {
        summaryId,
        summary: generateExtractiveFallback(sourceText),
        method: 'initial',
        editChainLength: 0,
      };
    }

    const prompt = buildGenerationPrompt(summaryType, sourceText, context);

    try {
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const summary = result.text?.trim();
      if (!summary) {
        throw new Error('Empty response from Gemini');
      }

      return {
        summaryId,
        summary,
        method: input.currentSummary ? 'regenerate' : 'initial',
        editChainLength: 0,
      };
    } catch (error) {
      logger.warn(
        { summaryId, summaryType, error },
        'Summary generation failed, using extractive fallback',
      );

      return {
        summaryId,
        summary: generateExtractiveFallback(sourceText),
        method: 'initial',
        editChainLength: 0,
      };
    }
  },

  /**
   * Update a summary based on source text changes.
   * Uses unified diff format for minimal, focused edits.
   *
   * Per TDD Section 10.4: Force regeneration after N=10 edits.
   */
  async update(input: SummaryUpdateInput): Promise<SummaryResult> {
    const {
      summaryId,
      summaryType,
      currentSummary,
      sourceDiff,
      editChainLength,
      context,
    } = input;

    // Force regeneration if chain too long
    if (editChainLength >= EDIT_CHAIN_CONFIG.maxLength) {
      logger.info(
        { summaryId, editChainLength },
        'Forcing regeneration due to edit chain length',
      );

      // Signal that caller should regenerate with full source
      return {
        summaryId,
        summary: currentSummary,
        method: 'regenerate',
        editChainLength: 0,
      };
    }

    const client = await getGeminiClient();
    if (!client) {
      return {
        summaryId,
        summary: currentSummary,
        method: 'no_change',
        editChainLength,
      };
    }

    const prompt = buildUpdatePrompt(
      summaryType,
      currentSummary,
      sourceDiff,
      context,
    );

    try {
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const response = result.text?.trim();
      if (!response) {
        throw new Error('Empty response from Gemini');
      }

      // Check for NO_CHANGE
      if (isNoChangeResponse(response)) {
        return {
          summaryId,
          summary: currentSummary,
          method: 'no_change',
          editChainLength,
        };
      }

      // Try to apply as diff
      const extractedDiff = extractDiffContent(response);
      if (extractedDiff && isValidDiff(extractedDiff)) {
        try {
          const updatedSummary = applyUnifiedDiff(
            currentSummary,
            extractedDiff,
          );

          return {
            summaryId,
            summary: updatedSummary,
            method: 'edit',
            diff: extractedDiff,
            editChainLength: editChainLength + 1,
          };
        } catch (err) {
          logger.warn(
            { summaryId, error: err },
            'Failed to apply diff, checking if response is valid replacement',
          );
        }
      }

      // Response wasn't a valid diff
      // Only use as replacement if it looks like actual summary content
      const looksLikeSummary =
        response.length > 50 &&
        !response.includes('@@') &&
        !response.startsWith('-');

      if (looksLikeSummary) {
        return {
          summaryId,
          summary: response,
          method: 'regenerate',
          editChainLength: 0,
        };
      }

      // Keep current summary if response is garbled
      logger.warn(
        { summaryId, responsePreview: response.slice(0, 100) },
        'Invalid update response, keeping current summary',
      );

      return {
        summaryId,
        summary: currentSummary,
        method: 'no_change',
        editChainLength,
      };
    } catch (error) {
      logger.warn(
        { summaryId, error },
        'Summary update failed, keeping current',
      );

      return {
        summaryId,
        summary: currentSummary,
        method: 'no_change',
        editChainLength,
      };
    }
  },

  /**
   * Compute a unified diff between two texts.
   * Uses shared diffUtils with proper LCS algorithm.
   */
  computeDiff,

  /**
   * Check if a summary needs update based on source changes.
   * Returns true if diff is significant enough to warrant update.
   */
  needsUpdate(sourceDiff: string): boolean {
    return hasSignificantChanges(
      sourceDiff,
      CONFLICT_CONFIG.minChangesForUpdate,
    );
  },

  /**
   * Reconstruct a version from delta chain.
   * Used when accessing historical versions stored as deltas.
   */
  reconstructFromDeltas(
    currentContent: string,
    deltas: Array<{ delta: string; versionNumber: number }>,
    targetVersion: number,
  ): string {
    // Sort deltas from current to target (reverse order)
    const sortedDeltas = deltas
      .filter((d) => d.versionNumber > targetVersion)
      .sort((a, b) => b.versionNumber - a.versionNumber);

    let content = currentContent;

    for (const { delta } of sortedDeltas) {
      const inverseDelta = invertDiff(delta);
      content = applyUnifiedDiff(content, inverseDelta);
    }

    return content;
  },

  // Export config values for external use
  MAX_EDIT_CHAIN_LENGTH: EDIT_CHAIN_CONFIG.maxLength,
  MAX_DELTA_CHAIN_DEPTH: EDIT_CHAIN_CONFIG.maxDeltaChainDepth,
};

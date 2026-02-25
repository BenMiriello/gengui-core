/**
 * Shared utilities for summary generation.
 * Reduces duplication between segment and document summary logic.
 */

import { CONFIG } from './config';

export interface SummaryPromptConfig {
  type: 'segment' | 'document';
  content: string;
  context?: {
    segmentIndex?: number;
    totalSegments?: number;
    documentTitle?: string;
  };
  targetWords?: number;
}

export function buildSummaryPrompt(config: SummaryPromptConfig): string {
  const { type, content, context, targetWords = CONFIG.targetSummaryWords } = config;

  const baseInstructions = `Focus on:
- Named entities (characters, places, things) and their actions
- Key events that occurred
- Important facts or revelations
- Causal relationships (what caused what)

Maintain chronological order. Use present tense. Preserve entity names exactly.`;

  let contextLine = '';
  if (type === 'segment' && context?.segmentIndex !== undefined) {
    contextLine = `SEGMENT ${context.segmentIndex + 1} of ${context.totalSegments}:\n`;
  } else if (context?.documentTitle) {
    contextLine = `Title: ${context.documentTitle}\n\n`;
  }

  return `Summarize in ${targetWords} words. ${baseInstructions}

${contextLine}${content}

Write the summary directly (no JSON, no preamble):`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

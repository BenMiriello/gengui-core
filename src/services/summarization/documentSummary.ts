/**
 * Document-level summary generation from segment summaries.
 */

import { logger } from '../../utils/logger';
import { trackedAI } from '../ai';
import { getGeminiClient } from '../gemini/core';
import { CONFIG } from './config';

export async function generateDocumentSummary(
  segmentSummaries: string[],
  userId: string,
  documentId?: string,
  documentTitle?: string,
): Promise<string> {
  // Validation
  if (!segmentSummaries || segmentSummaries.length === 0) {
    throw new Error('Cannot generate document summary from empty summaries');
  }

  const client = await getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client not initialized');
  }

  const titleSection = documentTitle ? `Title: ${documentTitle}\n\n` : '';
  const summariesText = segmentSummaries
    .map((s, i) => `[Segment ${i + 1}]: ${s}`)
    .join('\n\n');

  const prompt = `Create a comprehensive document summary (300-500 words) from these segment summaries.

Focus on:
- Main characters and their roles
- Central plot/narrative arc
- Key themes and motifs
- Major events in chronological order
- Overall tone and style

${titleSection}SEGMENT SUMMARIES:
${summariesText}

Write the summary directly (no preamble):`;

  const result = await trackedAI.callLLM({
    operation: 'generateDocumentSummary',
    model: CONFIG.documentSummaryModel,
    userId,
    documentId,
    stage: 2,
    logger,
    execute: async () =>
      client.models.generateContent({
        model: CONFIG.documentSummaryModel,
        contents: prompt,
      }),
  });

  const summary = (result.text ?? '').trim();

  // Validation
  if (!summary || summary.length === 0) {
    throw new Error('Empty document summary generated');
  }

  logger.info(
    {
      inputSegments: segmentSummaries.length,
      outputLength: summary.length,
      outputWords: summary.split(/\s+/).length,
    },
    'Document summary generated',
  );

  return summary;
}

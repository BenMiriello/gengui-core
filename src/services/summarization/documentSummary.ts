/**
 * Document-level summary generation from segment summaries.
 */

import { getGeminiClient } from '../gemini/core';
import { logger } from '../../utils/logger';
import { logLLMCall } from '../../utils/logHelpers';
import { CONFIG } from './config';
import { getTextModelConfig } from '../../config/text-models';

export async function generateDocumentSummary(
  segmentSummaries: string[],
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

  const callStartTime = Date.now();
  const result = await client.models.generateContent({
    model: CONFIG.documentSummaryModel,
    contents: prompt,
  });
  const durationMs = Date.now() - callStartTime;

  const modelConfig = getTextModelConfig(CONFIG.documentSummaryModel);
  const inputTokens = result.usageMetadata?.promptTokenCount || Math.ceil(prompt.length / modelConfig.charsPerToken);
  const outputTokens = result.usageMetadata?.candidatesTokenCount || Math.ceil((result.text?.length || 0) / modelConfig.charsPerToken);

  logLLMCall(logger, {
    operation: 'generateDocumentSummary',
    model: CONFIG.documentSummaryModel,
    promptTokens: inputTokens,
    responseTokens: outputTokens,
    durationMs,
    prompt: process.env.LOG_LEVEL === 'debug' ? prompt.slice(0, 500) : undefined,
    response: process.env.LOG_LEVEL === 'debug' ? result.text?.slice(0, 500) : undefined,
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
    'Document summary generated'
  );

  return summary;
}

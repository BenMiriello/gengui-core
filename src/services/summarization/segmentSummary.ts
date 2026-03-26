/**
 * Segment-level summary generation with retry logic and validation.
 */

import { logger } from '../../utils/logger';
import { trackedAI } from '../ai';
import { getGeminiClient } from '../gemini/core';
import { CONFIG } from './config';
import { buildSummaryPrompt, sleep } from './shared';

export async function generateSegmentSummary(
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
  userId: string,
  documentId?: string,
): Promise<string> {
  // Input validation
  if (!segmentText || segmentText.trim().length === 0) {
    throw new Error(`Segment ${segmentIndex} has empty text`);
  }

  let validatedText = segmentText;
  if (segmentText.length > CONFIG.maxSegmentChars) {
    logger.warn(
      { segmentIndex, length: segmentText.length, max: CONFIG.maxSegmentChars },
      'Segment exceeds max length, truncating for summary generation',
    );
    validatedText = segmentText.slice(0, CONFIG.maxSegmentChars);
  }

  const client = await getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client not initialized');
  }

  const prompt = buildSummaryPrompt({
    type: 'segment',
    content: validatedText,
    context: { segmentIndex, totalSegments },
  });

  const result = await trackedAI.callLLM({
    operation: 'generateSegmentSummary',
    model: CONFIG.summaryModel,
    userId,
    documentId,
    stage: 2,
    logger,
    execute: async () =>
      client.models.generateContent({
        model: CONFIG.summaryModel,
        contents: prompt,
      }),
  });

  const summary = (result.text ?? '').trim();

  // Output validation
  if (!summary || summary.length === 0) {
    throw new Error(`Empty summary generated for segment ${segmentIndex}`);
  }

  if (summary.length > CONFIG.maxSummaryChars) {
    logger.warn(
      { segmentIndex, length: summary.length, max: CONFIG.maxSummaryChars },
      'Summary exceeds max length, truncating',
    );
    return summary.slice(0, CONFIG.maxSummaryChars);
  }

  return summary;
}

export async function generateSegmentSummaryWithRetry(
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
  userId: string,
  documentId?: string,
  attempt: number = 0,
): Promise<string> {
  try {
    return await generateSegmentSummary(
      segmentText,
      segmentIndex,
      totalSegments,
      userId,
      documentId,
    );
  } catch (error) {
    if (attempt >= CONFIG.maxRetries) {
      logger.error(
        { error, segmentIndex, attempt, maxRetries: CONFIG.maxRetries },
        'Summary generation failed after max retries, using fallback',
      );

      // Fallback for transient failures only (truncated segment text)
      const fallback = segmentText.slice(0, 500);
      return fallback + (segmentText.length > 500 ? '...' : '');
    }

    const backoffMs = CONFIG.baseBackoffMs * 2 ** attempt;
    logger.warn(
      {
        error,
        segmentIndex,
        attempt,
        backoffMs,
        maxRetries: CONFIG.maxRetries,
      },
      'Summary generation failed, retrying after exponential backoff',
    );

    await sleep(backoffMs);
    return generateSegmentSummaryWithRetry(
      segmentText,
      segmentIndex,
      totalSegments,
      userId,
      documentId,
      attempt + 1,
    );
  }
}

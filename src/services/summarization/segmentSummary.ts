/**
 * Segment-level summary generation with retry logic and validation.
 */

import { getGeminiClient } from '../gemini/core';
import { logger } from '../../utils/logger';
import { logLLMCall } from '../../utils/logHelpers';
import { CONFIG } from './config';
import { buildSummaryPrompt, sleep } from './shared';
import { getTextModelConfig } from '../../config/text-models';

export async function generateSegmentSummary(
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
): Promise<string> {
  // Input validation
  if (!segmentText || segmentText.trim().length === 0) {
    throw new Error(`Segment ${segmentIndex} has empty text`);
  }

  let validatedText = segmentText;
  if (segmentText.length > CONFIG.maxSegmentChars) {
    logger.warn(
      { segmentIndex, length: segmentText.length, max: CONFIG.maxSegmentChars },
      'Segment exceeds max length, truncating for summary generation'
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

  const callStartTime = Date.now();
  const result = await client.models.generateContent({
    model: CONFIG.summaryModel,
    contents: prompt,
  });
  const durationMs = Date.now() - callStartTime;

  const modelConfig = getTextModelConfig(CONFIG.summaryModel);
  const inputTokens = result.usageMetadata?.promptTokenCount || Math.ceil(prompt.length / modelConfig.charsPerToken);
  const outputTokens = result.usageMetadata?.candidatesTokenCount || Math.ceil((result.text?.length || 0) / modelConfig.charsPerToken);

  logLLMCall(logger, {
    operation: 'generateSegmentSummary',
    model: CONFIG.summaryModel,
    promptTokens: inputTokens,
    responseTokens: outputTokens,
    durationMs,
    prompt: process.env.LOG_LEVEL === 'debug' ? prompt.slice(0, 500) : undefined,
    response: process.env.LOG_LEVEL === 'debug' ? result.text?.slice(0, 500) : undefined,
  });

  const summary = (result.text ?? '').trim();

  // Output validation
  if (!summary || summary.length === 0) {
    throw new Error(`Empty summary generated for segment ${segmentIndex}`);
  }

  if (summary.length > CONFIG.maxSummaryChars) {
    logger.warn(
      { segmentIndex, length: summary.length, max: CONFIG.maxSummaryChars },
      'Summary exceeds max length, truncating'
    );
    return summary.slice(0, CONFIG.maxSummaryChars);
  }

  return summary;
}

export async function generateSegmentSummaryWithRetry(
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
  attempt: number = 0,
): Promise<string> {
  try {
    return await generateSegmentSummary(segmentText, segmentIndex, totalSegments);
  } catch (error) {
    if (attempt >= CONFIG.maxRetries) {
      logger.error(
        { error, segmentIndex, attempt, maxRetries: CONFIG.maxRetries },
        'Summary generation failed after max retries, using fallback'
      );

      // Fallback: truncated segment text as "summary"
      const fallback = segmentText.slice(0, 500);
      return fallback + (segmentText.length > 500 ? '...' : '');
    }

    const backoffMs = CONFIG.baseBackoffMs * Math.pow(2, attempt);
    logger.warn(
      { error, segmentIndex, attempt, backoffMs, maxRetries: CONFIG.maxRetries },
      'Summary generation failed, retrying after exponential backoff'
    );

    await sleep(backoffMs);
    return generateSegmentSummaryWithRetry(
      segmentText,
      segmentIndex,
      totalSegments,
      attempt + 1
    );
  }
}

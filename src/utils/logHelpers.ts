/**
 * Reusable logging patterns for consistent instrumentation.
 *
 * Standard mode (LOG_VERBOSE=false):
 *   - INFO: Token counts, duration, cost only
 *   - DEBUG: Adds 500-char truncated previews
 *
 * Verbose mode (LOG_VERBOSE=true, LOCAL ONLY):
 *   - Logs FULL prompts and responses
 *   - Blocked in production for PII safety
 */

import type { Logger } from 'pino';
import { isVerboseLoggingEnabled } from '../config/logging';
import { estimateCost } from './costEstimation';

interface LLMCallMetadata {
  operation: string;
  model: string;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  prompt?: string;
  response?: string;
}

/**
 * Log LLM call with token counts and cost tracking.
 *
 * Token counts are REAL data from API usageMetadata when available.
 * Fallback estimates are only used if API doesn't report counts.
 *
 * Cost estimates use verified pricing from https://ai.google.dev/pricing
 *
 * Respects LOG_VERBOSE env var (local only):
 * - false: Truncated 500-char previews at DEBUG
 * - true: Full prompts/responses (never in production)
 */
export function logLLMCall(logger: Logger, metadata: LLMCallMetadata): void {
  const {
    prompt,
    response,
    operation,
    model,
    promptTokens,
    responseTokens,
    durationMs,
  } = metadata;
  const isVerbose = isVerboseLoggingEnabled();

  // INFO: Token counts and cost (always)
  logger.info(
    {
      operation,
      model,
      inputTokens: promptTokens,
      outputTokens: responseTokens,
      totalTokens: promptTokens + responseTokens,
      durationMs,
      costEstimate: estimateCost(promptTokens, responseTokens, model),
    },
    'LLM call completed',
  );

  // DEBUG: Prompt/response content
  if (prompt && response && logger.level === 'debug') {
    if (isVerbose) {
      // VERBOSE: Full content (local only)
      logger.debug(
        {
          operation,
          prompt,
          response,
          _verbose: true,
        },
        'LLM call (VERBOSE)',
      );
    } else {
      // STANDARD: Truncated previews only
      logger.debug(
        {
          operation,
          promptPreview: prompt.slice(0, 500),
          responsePreview: response.slice(0, 500),
        },
        'LLM call preview',
      );
    }
  }
}

export function logStageStart(
  logger: Logger,
  stage: number,
  stageName: string,
  context?: Record<string, any>,
): void {
  logger.info(
    {
      stage,
      stageName,
      status: 'started',
      ...context,
    },
    `Stage ${stage}: ${stageName} started`,
  );
}

export function logStageComplete(
  logger: Logger,
  stage: number,
  stageName: string,
  durationMs: number,
  metrics: Record<string, any>,
): void {
  logger.info(
    {
      stage,
      stageName,
      status: 'completed',
      durationMs,
      ...metrics,
    },
    `Stage ${stage}: ${stageName} completed`,
  );
}

/**
 * Log entity extraction results.
 *
 * Standard mode: Counts only (PII-safe)
 * Verbose mode: Includes entity names and sample facets (local only)
 */
export function logEntityExtraction(
  logger: Logger,
  entities: Array<{
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
  }>,
  context?: Record<string, any>,
): void {
  const isVerbose = isVerboseLoggingEnabled();

  if (isVerbose) {
    // VERBOSE: Include actual entity names and facets
    logger.debug(
      {
        entityCount: entities.length,
        entities: entities.map((e) => ({
          name: e.name,
          type: e.type,
          facetCount: e.facets.length,
          sampleFacets: e.facets
            .slice(0, 3)
            .map((f) => ({ type: f.type, content: f.content })),
        })),
        _verbose: true,
        ...context,
      },
      'Entities extracted (VERBOSE)',
    );
  } else {
    // STANDARD: Counts only (PII-safe)
    logger.debug(
      {
        entityCount: entities.length,
        averageFacetsPerEntity: (
          entities.reduce((sum, e) => sum + e.facets.length, 0) /
          entities.length
        ).toFixed(1),
        typeDistribution: entities.reduce(
          (acc, e) => {
            acc[e.type] = (acc[e.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
        ...context,
      },
      'Entities extracted (counts)',
    );
  }
}

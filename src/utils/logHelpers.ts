/**
 * Reusable logging patterns for consistent instrumentation.
 */

import type { Logger } from 'pino';
import { aiLogger, generateAICallId } from './logger';
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

export function logLLMCall(
  mainLogger: Logger,
  metadata: LLMCallMetadata,
): string {
  const aiCallId = generateAICallId();
  const { prompt, response, ...metadataWithoutContent } = metadata;

  // Main log: metadata only
  mainLogger.info(
    {
      operation: metadata.operation,
      aiCallId,
      inputTokens: metadata.promptTokens,
      outputTokens: metadata.responseTokens,
      totalTokens: metadata.promptTokens + metadata.responseTokens,
      durationMs: metadata.durationMs,
      costEstimate: estimateCost(
        metadata.promptTokens,
        metadata.responseTokens,
        metadata.model,
      ),
    },
    'LLM call completed',
  );

  // AI log: full details (if enabled)
  if (prompt && response) {
    const bindings = mainLogger.bindings();
    aiLogger.debug(
      {
        aiCallId,
        requestId: bindings.requestId,
        documentId: bindings.documentId,
        operation: metadata.operation,
        model: metadata.model,
        prompt,
        response,
        metadata: {
          promptTokens: metadata.promptTokens,
          responseTokens: metadata.responseTokens,
          durationMs: metadata.durationMs,
        },
      },
      'AI interaction',
    );
  }

  return aiCallId;
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

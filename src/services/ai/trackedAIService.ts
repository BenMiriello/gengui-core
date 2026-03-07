/**
 * Enforced wrapper for all LLM calls with automatic usage tracking.
 * TypeScript enforces userId at compile time - impossible to forget tracking.
 */

import type { Logger } from 'pino';
import { calculateLLMCost } from '../../config/pricing.js';
import { logger as defaultLogger } from '../../utils/logger';
import { logLLMCall } from '../../utils/logHelpers';
import { usageTrackingService } from '../usageTracking';

interface LLMResponse {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  [key: string]: any;
}

interface CallLLMParams {
  operation: string;
  model: string;
  userId: string;
  documentId?: string;
  requestId?: string;
  stage?: number;
  logger?: Logger;
  execute: () => Promise<LLMResponse>;
}

export class TrackedAIService {
  /**
   * Only call LLMs with this automatic usage tracking wrapper.
   */
  async callLLM(params: CallLLMParams): Promise<LLMResponse> {
    const {
      operation,
      model,
      userId,
      documentId,
      requestId,
      stage,
      logger = defaultLogger,
      execute,
    } = params;

    const startTime = Date.now();

    try {
      const result = await execute();
      const durationMs = Date.now() - startTime;

      const inputTokens = result.usageMetadata?.promptTokenCount || 0;
      const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;
      const { apiCostUsd } = calculateLLMCost({
        model,
        inputTokens,
        outputTokens,
      });

      logLLMCall(logger, {
        operation,
        model,
        promptTokens: inputTokens,
        responseTokens: outputTokens,
        durationMs,
      });

      usageTrackingService
        .recordLLMUsage({
          userId,
          documentId,
          requestId,
          operation,
          model,
          inputTokens,
          outputTokens,
          costUsd: apiCostUsd,
          durationMs,
          stage,
        })
        .catch((err) => {
          logger.error(
            { err, userId, operation },
            'Usage tracking failed (non-blocking)',
          );
        });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error(
        {
          operation,
          userId,
          documentId,
          error: (error as Error).message,
          durationMs,
        },
        'LLM call failed',
      );
      throw error;
    }
  }
}

export const trackedAI = new TrackedAIService();

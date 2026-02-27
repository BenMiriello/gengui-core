/**
 * Centralized LLM client wrapper with sensible defaults.
 *
 * Eliminates configuration brittleness by applying best practices automatically:
 * - maxOutputTokens: 65536 (from model config, not 8K default)
 * - thinkingConfig: { thinkingBudget: 0 } (eliminate latency/cost)
 * - Retry logic with exponential backoff
 * - Error handling with user-friendly messages
 * - Cost tracking via trackedAI.callLLM()
 * - Structured logging
 */

import type { Logger } from 'pino';
import { getTextModelConfig } from '../../config/text-models';
import { logger as defaultLogger } from '../../utils/logger';
import { trackedAI } from '../ai';
import { getGeminiClient } from '../gemini/core';
import { DEFAULT_CONFIG } from './config';
import { handleApiError, isRetryableError } from './errors';
import type {
  GenerateJSONParams,
  GenerateTextParams,
  LLMResponse,
} from './types';

export class LLMClient {
  /**
   * Generate text with automatic defaults and retry logic.
   */
  async generateText(params: GenerateTextParams): Promise<string> {
    const result = await this.execute(params);
    return (result.text ?? '').trim();
  }

  /**
   * Generate JSON with schema validation and automatic defaults.
   */
  async generateJSON<T>(params: GenerateJSONParams<T>): Promise<T> {
    const result = await this.execute({
      ...params,
      responseMimeType: 'application/json',
    });

    const parsed = this.parseJSONResponse<T>(
      result,
      params.operation || 'generateJSON',
      params.logger,
    );

    if (params.validateResponse) {
      return params.validateResponse(parsed);
    }

    return parsed;
  }

  /**
   * Core execution logic with retry handling and cost tracking.
   */
  private async execute(
    params: GenerateTextParams & { responseMimeType?: string },
  ): Promise<LLMResponse> {
    const {
      prompt,
      userId,
      documentId,
      requestId,
      operation = 'llm-call',
      stage,
      logger = defaultLogger,
      model = DEFAULT_CONFIG.model,
      maxRetries = DEFAULT_CONFIG.maxRetries,
      timeout = DEFAULT_CONFIG.timeout,
      thinkingConfig = DEFAULT_CONFIG.thinkingConfig,
      responseMimeType,
    } = params;

    const client = await getGeminiClient();
    if (!client) {
      throw new Error(
        'Gemini API client not initialized - GEMINI_API_KEY missing',
      );
    }

    const modelConfig = getTextModelConfig(model);
    const maxOutputTokens =
      params.maxOutputTokens ?? modelConfig.maxOutputTokens;

    if (!maxOutputTokens) {
      throw new Error(
        `Model ${model} missing maxOutputTokens configuration`,
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const startTime = Date.now();

      try {
        const config: any = {
          maxOutputTokens,
          thinkingConfig,
        };

        if (timeout) {
          config.httpOptions = { timeout };
        }

        if (responseMimeType) {
          config.responseMimeType = responseMimeType;
          config.responseJsonSchema = (params as any).schema;
        }

        const result = await trackedAI.callLLM({
          operation,
          model,
          userId,
          documentId,
          requestId,
          stage,
          logger,
          execute: async () =>
            client.models.generateContent({
              model,
              contents: prompt,
              config,
            }),
        });

        return result;
      } catch (error: any) {
        lastError = error;
        const durationMs = Date.now() - startTime;

        if (attempt < maxRetries - 1 && isRetryableError(error)) {
          const retryDelayMs = DEFAULT_CONFIG.retryDelays[attempt];
          logger.warn(
            {
              operation,
              attempt: attempt + 1,
              maxRetries,
              error: error?.message,
              durationMs,
              retryDelayMs,
            },
            `${operation} attempt failed, retrying`,
          );

          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } else {
          break;
        }
      }
    }

    throw handleApiError(lastError, operation);
  }

  /**
   * Parse and validate JSON response from LLM.
   */
  private parseJSONResponse<T>(
    result: LLMResponse,
    operation: string,
    logger: Logger = defaultLogger,
  ): T {
    if (!result?.candidates?.length) {
      const blockReason = result?.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(`Content blocked: ${blockReason}`);
      }
      throw new Error('Empty response from API');
    }

    const text = result.text;
    if (!text?.trim()) {
      throw new Error('Empty response text');
    }

    const trimmed = text.trim();
    const looksComplete = trimmed.endsWith('}') || trimmed.endsWith(']');
    const finishReason = result.candidates?.[0]?.finishReason;

    try {
      return JSON.parse(text) as T;
    } catch (parseError: any) {
      logger.error(
        {
          operation,
          responseLength: text.length,
          responseStart: text.slice(0, 500),
          responseEnd: text.slice(-500),
          looksComplete,
          finishReason,
          parseError: parseError?.message,
        },
        `JSON parse failed for ${operation}`,
      );

      let hint = '';
      if (!looksComplete) {
        hint = ' Response appears truncated (does not end with } or ]).';
      }
      if (finishReason && finishReason !== 'STOP') {
        hint += ` Finish reason: ${finishReason}.`;
      }

      throw new Error(`Failed to parse ${operation} response as JSON.${hint}`);
    }
  }
}

export const llmClient = new LLMClient();

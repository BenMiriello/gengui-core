/**
 * Type definitions for centralized LLM client.
 */

import type { Logger } from 'pino';
import type { TextModelId } from '../../config/text-models';

export interface BaseLLMParams {
  prompt: string;
  userId: string;
  documentId?: string;
  requestId?: string;
  operation?: string;
  stage?: number;
  logger?: Logger;

  model?: TextModelId;
  maxOutputTokens?: number;
  thinkingConfig?: { thinkingBudget: number };
  timeout?: number;
  maxRetries?: number;
}

export interface GenerateTextParams extends BaseLLMParams {}

export interface GenerateJSONParams<T> extends BaseLLMParams {
  schema: object;
  validateResponse?: (data: unknown) => T;
}

export interface LLMResponse {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  candidates?: Array<{
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
  [key: string]: unknown;
}

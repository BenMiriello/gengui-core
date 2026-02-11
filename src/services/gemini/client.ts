/**
 * Gemini API client for story node analysis.
 * Thin wrapper handling API calls, retries, and error handling.
 */

import { analyzeTextPrompt, updateNodesPrompt } from '../../prompts/storyNodes';
import type { AnalysisResult, ExistingNode, NodeUpdatesResult } from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import { getGeminiClient } from './core';
import { analyzeResponseSchema, updateNodesResponseSchema } from './schemas/storyNodes';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Analyze narrative text and extract story elements.
 */
export async function analyzeText(content: string): Promise<AnalysisResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
  }

  const prompt = analyzeTextPrompt.build({ content });

  try {
    const result = await client.models.generateContent({
      model: analyzeTextPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: analyzeResponseSchema,
      },
    });

    const parsed = parseResponse<AnalysisResult>(result, 'analyzeText');

    logger.info(
      {
        nodesCount: parsed.nodes.length,
        connectionsCount: parsed.connections.length,
      },
      'Story elements extracted'
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Analysis');
  }
}

/**
 * Analyze document for incremental changes to existing nodes.
 * Uses retry logic with progressive backoff.
 */
export async function updateNodes(
  content: string,
  existingNodes: ExistingNode[]
): Promise<NodeUpdatesResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
  }

  const prompt = updateNodesPrompt.build({ content, existingNodes });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await client.models.generateContent({
        model: updateNodesPrompt.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: updateNodesResponseSchema,
        },
      });

      const parsed = parseResponse<NodeUpdatesResult>(result, 'updateNodes');
      validateUpdateResponse(parsed, existingNodes);

      logger.info(
        {
          addCount: parsed.add.length,
          updateCount: parsed.update.length,
          deleteCount: parsed.delete.length,
        },
        'Node updates parsed successfully'
      );

      return parsed;
    } catch (error: any) {
      lastError = error;
      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: error?.message,
        },
        'updateNodes attempt failed'
      );

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
      }
    }
  }

  throw lastError || new Error('updateNodes failed after retries');
}

/**
 * Parse and validate Gemini API response.
 */
function parseResponse<T>(result: any, operation: string): T {
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

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse ${operation} response as JSON`);
  }
}

/**
 * Validate that update response references valid node IDs.
 */
function validateUpdateResponse(parsed: NodeUpdatesResult, existingNodes: ExistingNode[]): void {
  if (
    !Array.isArray(parsed.add) ||
    !Array.isArray(parsed.update) ||
    !Array.isArray(parsed.delete) ||
    !parsed.connectionUpdates
  ) {
    throw new Error('Malformed response structure');
  }

  const existingIds = new Set(existingNodes.map((n) => n.id));

  for (const update of parsed.update) {
    if (!update.id || !existingIds.has(update.id)) {
      logger.error({ invalidId: update.id }, 'Update references non-existent node ID');
      throw new Error(`Update references invalid node ID: ${update.id}`);
    }
  }

  for (const deleteId of parsed.delete) {
    if (!existingIds.has(deleteId)) {
      logger.error({ invalidId: deleteId }, 'Delete references non-existent node ID');
      throw new Error(`Delete references invalid node ID: ${deleteId}`);
    }
  }
}

/**
 * Convert API errors to user-friendly messages.
 */
function handleApiError(error: any, operation: string): Error {
  const message = error?.message || '';

  if (message.includes('quota')) {
    return new Error('API quota exceeded. Please try again later.');
  }
  if (message.includes('rate limit')) {
    return new Error('Rate limit exceeded. Please wait a moment and try again.');
  }
  if (message.includes('404')) {
    return new Error('Analysis model not found. Check GEMINI_API_KEY and model configuration.');
  }
  if (message.includes('blocked') || message.includes('inappropriate')) {
    return error;
  }

  return new Error(`${operation} failed: ${message || 'Unknown error'}. Please try again.`);
}

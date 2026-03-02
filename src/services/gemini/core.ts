/**
 * Shared Gemini API client module.
 *
 * @google/genai is ESM-only, so we use dynamic imports to avoid TS1479 errors
 * in our CommonJS codebase. All Gemini usage should import from here.
 */

import { env } from '../../config/env';
import { logger } from '../../utils/logger';

// Cached client instance
// @ts-expect-error - Used in initialization promise chain
let genAIClient: Awaited<ReturnType<typeof createClient>> | null = null;
let initPromise: Promise<Awaited<ReturnType<typeof createClient>>> | null =
  null;

async function createClient() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/**
 * Get the shared Gemini client instance.
 * Lazily initializes on first call. Parallel calls await the same initialization.
 */
export async function getGeminiClient() {
  if (!initPromise) {
    initPromise = createClient().then((client) => {
      if (!client) {
        logger.warn('GEMINI_API_KEY not configured');
      }
      genAIClient = client;
      return client;
    });
  }
  return await initPromise;
}

/**
 * Check if Gemini is available (API key configured).
 */
export async function isGeminiAvailable(): Promise<boolean> {
  const client = await getGeminiClient();
  return client !== null;
}

/**
 * Type constants for Gemini schema definitions.
 * Mirrors @google/genai Type enum to avoid ESM import issues.
 */
export const GeminiType = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
} as const;

export type GeminiTypeValue = (typeof GeminiType)[keyof typeof GeminiType];

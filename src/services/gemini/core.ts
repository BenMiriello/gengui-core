/**
 * Shared Gemini API client module.
 *
 * @google/genai is ESM-only, so we use dynamic imports to avoid TS1479 errors
 * in our CommonJS codebase. All Gemini usage should import from here.
 */

import { logger } from '../../utils/logger';

// Cached client instance
let genAIClient: Awaited<ReturnType<typeof createClient>> | null = null;
let initialized = false;

async function createClient() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/**
 * Get the shared Gemini client instance.
 * Lazily initializes on first call.
 */
export async function getGeminiClient() {
  if (!initialized) {
    initialized = true;
    genAIClient = await createClient();
    if (!genAIClient) {
      logger.warn('GEMINI_API_KEY not configured');
    }
  }
  return genAIClient;
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

export type GeminiTypeValue = typeof GeminiType[keyof typeof GeminiType];

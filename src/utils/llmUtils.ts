/**
 * LLM response utilities.
 * Shared parsing, validation, and NO_CHANGE detection.
 */

/**
 * Check if LLM response indicates no change needed.
 * Handles various formats: "NO_CHANGE", "no_change", "No Change", etc.
 */
export function isNoChangeResponse(response: string): boolean {
  if (!response) return false;

  const normalized = response
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
  return normalized === 'NOCHANGE';
}

/**
 * Extract JSON from LLM response that may have markdown code blocks.
 */
export function extractJson<T>(response: string): T | null {
  if (!response) return null;

  const trimmed = response.trim();

  try {
    // Try to parse directly first
    return JSON.parse(trimmed) as T;
  } catch {
    // Look for JSON in code block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim()) as T;
      } catch {
        return null;
      }
    }

    // Try to find JSON object/array
    const objectMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[1]) as T;
      } catch {
        return null;
      }
    }

    return null;
  }
}

/**
 * Validate that response is a non-empty string.
 */
export function validateTextResponse(response: unknown): response is string {
  return typeof response === 'string' && response.trim().length > 0;
}

/**
 * Result type for LLM operations.
 */
export type LLMResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Wrap LLM call with error handling.
 */
export async function safeLLMCall<T>(
  operation: () => Promise<T>,
  operationName: string,
): Promise<LLMResult<T>> {
  try {
    const data = await operation();
    return { success: true, data };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown LLM error';
    return {
      success: false,
      error: `${operationName} failed: ${message}`,
    };
  }
}

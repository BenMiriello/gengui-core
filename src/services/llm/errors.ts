/**
 * Error handling utilities for LLM client.
 */

export function handleApiError(error: unknown, operation: string): Error {
  const message = (error as { message?: string })?.message || '';

  if (message.includes('quota')) {
    return new Error('API quota exceeded. Please try again later.');
  }
  if (message.includes('rate limit')) {
    return new Error(
      'Rate limit exceeded. Please wait a moment and try again.',
    );
  }
  if (message.includes('404')) {
    return new Error(
      'Model not found. Check GEMINI_API_KEY and model configuration.',
    );
  }
  if (
    message.includes('503') ||
    message.includes('UNAVAILABLE') ||
    message.includes('high demand')
  ) {
    return new Error('Service temporarily busy. Retrying automatically...');
  }
  if (message.includes('blocked') || message.includes('inappropriate')) {
    return error as Error;
  }

  return new Error(
    `${operation} failed: ${message || 'Unknown error'}. Please try again.`,
  );
}

export function isRetryableError(error: unknown): boolean {
  const message = (error as { message?: string })?.message || '';

  return (
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('503') ||
    message.includes('UNAVAILABLE') ||
    message.includes('high demand') ||
    message.includes('overloaded') ||
    message.includes('temporarily unavailable')
  );
}

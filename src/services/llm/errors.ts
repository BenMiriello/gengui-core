/**
 * Error handling utilities for LLM client.
 */

export function handleApiError(error: any, operation: string): Error {
  const message = error?.message || '';

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
  if (message.includes('blocked') || message.includes('inappropriate')) {
    return error;
  }

  return new Error(
    `${operation} failed: ${message || 'Unknown error'}. Please try again.`,
  );
}

export function isRetryableError(error: any): boolean {
  const message = error?.message || '';

  return (
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT')
  );
}

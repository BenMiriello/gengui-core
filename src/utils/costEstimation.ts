/**
 * Token cost estimation for LLM calls.
 *
 * Pricing source (verified 2025-02-25):
 * https://ai.google.dev/pricing#1_5flash
 *
 * Direct link to pricing table:
 * https://ai.google.dev/gemini-api/docs/models/gemini#gemini-1.5-flash
 *
 * NOTE: These are estimates based on publicly listed prices for Google AI Studio API.
 * Actual costs may vary based on:
 * - Google Cloud Vertex AI pricing (different rates)
 * - Volume discounts or enterprise agreements
 * - Regional pricing differences
 * - Promotional credits
 *
 * Always verify current pricing at the source link above before
 * using these estimates for budget planning.
 */

const PRICING = {
  'gemini-1.5-flash': {
    inputCost: 0.075,  // USD per 1M tokens (source: https://ai.google.dev/pricing)
    outputCost: 0.30,  // USD per 1M tokens
  },
  'gemini-2.0-flash-exp': {
    inputCost: 0.10,   // USD per 1M tokens (source: https://ai.google.dev/pricing)
    outputCost: 0.40,  // USD per 1M tokens
  },
  'gemini-1.5-pro': {
    inputCost: 1.25,   // USD per 1M tokens (source: https://ai.google.dev/pricing)
    outputCost: 5.00,  // USD per 1M tokens
  },
  // Aliases for common model names
  'gemini-2.5-flash': { // Alias for 2.0-flash-exp
    inputCost: 0.10,
    outputCost: 0.40,
  },
  'gemini-2.0-flash': { // Alias for 2.0-flash-exp
    inputCost: 0.10,
    outputCost: 0.40,
  },
  'gemini-2.5-flash-lite': {
    inputCost: 0.10,
    outputCost: 0.40,
  },
} as const;

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string = 'gemini-2.5-flash',
): number {
  const pricing = PRICING[model as keyof typeof PRICING];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCost;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCost;
  return inputCost + outputCost;
}

/**
 * Token cost estimation for LLM calls.
 *
 * Pricing source (verified 2026-02-25):
 * https://ai.google.dev/pricing
 *
 * NOTE: These are estimates based on publicly listed prices.
 * Actual costs may vary based on:
 * - Google Cloud billing agreements
 * - Regional pricing differences
 * - Promotional credits
 *
 * Always verify current pricing at the source link above before
 * using these estimates for budget planning.
 */

const PRICING = {
  'gemini-2.5-flash': {
    inputCost: 0.075, // USD per 1M tokens
    outputCost: 0.3,   // USD per 1M tokens
  },
  'gemini-2.5-pro': {
    inputCost: 1.25,   // USD per 1M tokens
    outputCost: 10.0,  // USD per 1M tokens
  },
  'gemini-2.0-flash': {
    inputCost: 0.1,    // USD per 1M tokens
    outputCost: 0.4,   // USD per 1M tokens
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

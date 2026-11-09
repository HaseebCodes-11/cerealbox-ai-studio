/**
 * Token estimation and pricing so every run reports what it would cost on a
 * real model. Prices are USD per million tokens (Anthropic first-party API).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Rough estimate: ~4 characters per token for English prose and JSON. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, model: string = DEFAULT_MODEL): number {
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL]!;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Minimum prompt-prefix length the API will cache, per model (tokens). Below
 * it `cache_control` is accepted and silently ignored. Source: Anthropic
 * prompt-caching reference, "minimum cacheable prompt length" (512 on the
 * current Opus/Sonnet/Haiku 5.x models).
 */
export const CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-5-5": 512,
  "claude-sonnet-5-5": 512,
  "claude-haiku-5-5": 512,
};
export const DEFAULT_CACHE_MIN_TOKENS = 512;

export interface Cacheability {
  estimatedTokens: number;
  minimumTokens: number;
  cacheable: boolean;
}

/** Whether a system prompt is long enough for prompt caching to engage on the given model (COST-01). */
export function promptCacheability(systemPrompt: string, model: string = DEFAULT_MODEL): Cacheability {
  const estimatedTokens = estimateTokens(systemPrompt);
  const minimumTokens = CACHE_MIN_TOKENS[model] ?? DEFAULT_CACHE_MIN_TOKENS;
  return { estimatedTokens, minimumTokens, cacheable: estimatedTokens >= minimumTokens };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

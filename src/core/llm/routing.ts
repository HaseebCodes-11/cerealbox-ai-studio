/**
 * Model routing by effort tier (COST-02) and output ceilings (COST-03).
 *
 * Every task declares an `effort`; by default every task also runs on the
 * single configured model, exactly as before. Setting ANTHROPIC_MODEL_LOW /
 * _MEDIUM / _HIGH routes that tier to a different model (for example Haiku
 * for the "low" classification and narration tasks, which cost ~40× less per
 * token than Opus) without touching any task definition. A task may also pin
 * its own `model`, which wins over the environment.
 */
export type Effort = "low" | "medium" | "high";

export interface RoutingEnv {
  ANTHROPIC_MODEL?: string | undefined;
  ANTHROPIC_MODEL_LOW?: string | undefined;
  ANTHROPIC_MODEL_MEDIUM?: string | undefined;
  ANTHROPIC_MODEL_HIGH?: string | undefined;
}

export const DEFAULT_EFFORT: Effort = "medium";
/** Output ceiling used when a task does not declare `maxOutputTokens` (unchanged from the original provider). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export function resolveModel(task: { effort?: Effort | undefined; model?: string | undefined }, env: RoutingEnv, fallback: string): string {
  if (task.model) return task.model;
  const effort = task.effort ?? DEFAULT_EFFORT;
  const tiered = effort === "low" ? env.ANTHROPIC_MODEL_LOW : effort === "high" ? env.ANTHROPIC_MODEL_HIGH : env.ANTHROPIC_MODEL_MEDIUM;
  return tiered || fallback;
}

export function resolveMaxOutputTokens(task: { maxOutputTokens?: number | undefined }): number {
  const n = task.maxOutputTokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Pick only the routing keys out of a process environment so providers never hold the whole env. */
export function routingFromEnv(env: Record<string, string | undefined> = process.env): RoutingEnv {
  return {
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    ANTHROPIC_MODEL_LOW: env.ANTHROPIC_MODEL_LOW,
    ANTHROPIC_MODEL_MEDIUM: env.ANTHROPIC_MODEL_MEDIUM,
    ANTHROPIC_MODEL_HIGH: env.ANTHROPIC_MODEL_HIGH,
  };
}

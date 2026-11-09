import type { z } from "zod";
import type { Rng } from "../rng";

/**
 * Every AI step in the system is a "task": a typed input, a prompt, an output
 * schema and a deterministic mock. The provider decides whether to call a real
 * model or the mock. This gives us:
 *  - offline, reproducible demos and tests (mock)
 *  - the same code path with Claude in production (anthropic)
 *  - schema validation on every output, whichever provider ran it
 */

export interface MockContext {
  rng: Rng;
}

export interface LLMTask<I, O> {
  /** Stable identifier, e.g. "copy.generate". Also used to seed the mock. */
  name: string;
  description: string;
  schema: z.ZodType<O>;
  system: string;
  prompt: (input: I) => string;
  mock: (input: I, ctx: MockContext) => O;
  effort?: "low" | "medium" | "high";
}

export interface LLMUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface LLMResult<O> {
  taskName: string;
  output: O;
  usage: LLMUsage;
}

export interface LLMProvider {
  readonly name: string;
  run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>>;
}

export function defineTask<I, O>(task: LLMTask<I, O>): LLMTask<I, O> {
  return task;
}

export class LLMOutputError extends Error {
  constructor(
    message: string,
    public readonly taskName: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "LLMOutputError";
  }
}

import { Rng, hashString } from "../rng";
import { DEFAULT_MODEL, estimateCostUsd, estimateTokens } from "../cost";
import { resolveModel, routingFromEnv, type RoutingEnv } from "./routing";
import { LLMOutputError, type LLMProvider, type LLMResult, type LLMTask } from "./provider";

/**
 * Deterministic provider. Runs the task's mock generator, validates the result
 * against the task schema (so a mock can never produce something the real model
 * would be rejected for), and reports the cost the same call would have had on
 * the configured model so demos show realistic economics.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly seed: string;
  private readonly pricingModel: string;
  private readonly routing: RoutingEnv;

  constructor(options: { seed?: string; pricingModel?: string; routing?: RoutingEnv } = {}) {
    this.seed = options.seed ?? "cerealbox";
    this.pricingModel = options.pricingModel ?? DEFAULT_MODEL;
    this.routing = options.routing ?? routingFromEnv();
  }

  async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
    const started = Date.now();
    const rng = new Rng(hashString(`${this.seed}:${task.name}:${stableStringify(input)}`));
    const raw = task.mock(input, { rng });
    const parsed = task.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMOutputError(
        `Mock output for ${task.name} failed schema validation: ${parsed.error.message}`,
        task.name,
        raw,
      );
    }
    const promptText = `${task.system}\n${task.prompt(input)}`;
    const inputTokens = estimateTokens(promptText);
    const outputTokens = estimateTokens(JSON.stringify(parsed.data));
    const model = resolveModel(task, this.routing, this.pricingModel);
    return {
      taskName: task.name,
      output: parsed.data,
      usage: {
        provider: this.name,
        model,
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(inputTokens, outputTokens, model),
        latencyMs: Date.now() - started,
      },
    };
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

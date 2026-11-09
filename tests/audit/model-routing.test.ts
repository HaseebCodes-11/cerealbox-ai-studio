import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_MODEL, estimateCostUsd, MODEL_PRICING } from "../../src/core/cost";
import { DEFAULT_MAX_OUTPUT_TOKENS, MockProvider, defineTask, resolveMaxOutputTokens, resolveModel, routingFromEnv } from "../../src/core/llm";
import { AnthropicProvider } from "../../src/core/llm/anthropic";

const schema = z.object({ label: z.string() });
const low = defineTask<{ q: string }, { label: string }>({ name: "t.low", description: "classify", schema, system: "Classify.", prompt: (i) => i.q, mock: () => ({ label: "ok" }), effort: "low" });
const medium = defineTask<{ q: string }, { label: string }>({ name: "t.medium", description: "write", schema, system: "Write.", prompt: (i) => i.q, mock: () => ({ label: "ok" }), effort: "medium" });
const untagged = defineTask<{ q: string }, { label: string }>({ name: "t.untagged", description: "write", schema, system: "Write.", prompt: (i) => i.q, mock: () => ({ label: "ok" }) });
const pinned = defineTask<{ q: string }, { label: string }>({ name: "t.pinned", description: "pinned", schema, system: "Pinned.", prompt: (i) => i.q, mock: () => ({ label: "ok" }), effort: "low", model: "claude-sonnet-5-5", maxOutputTokens: 800 });

describe("resolveModel (COST-02)", () => {
  it("falls back to the configured model when nothing is routed", () => {
    expect(resolveModel(low, {}, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(resolveModel(untagged, {}, "x")).toBe("x");
  });
  it("routes by effort tier, treating an untagged task as medium", () => {
    const env = { ANTHROPIC_MODEL_LOW: "claude-haiku-5-5", ANTHROPIC_MODEL_MEDIUM: "claude-sonnet-5-5" };
    expect(resolveModel(low, env, DEFAULT_MODEL)).toBe("claude-haiku-5-5");
    expect(resolveModel(medium, env, DEFAULT_MODEL)).toBe("claude-sonnet-5-5");
    expect(resolveModel(untagged, env, DEFAULT_MODEL)).toBe("claude-sonnet-5-5");
    expect(resolveModel({ effort: "high" }, env, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
  });
  it("a task's own model pin wins over the environment", () => {
    expect(resolveModel(pinned, { ANTHROPIC_MODEL_LOW: "claude-haiku-5-5" }, DEFAULT_MODEL)).toBe("claude-sonnet-5-5");
  });
  it("ignores empty strings from the environment", () => {
    expect(resolveModel(low, { ANTHROPIC_MODEL_LOW: "" }, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
  });
  it("routingFromEnv only copies the routing keys", () => {
    expect(routingFromEnv({ ANTHROPIC_MODEL_LOW: "a", ANTHROPIC_API_KEY: "secret", PATH: "x" })).toEqual({ ANTHROPIC_MODEL: undefined, ANTHROPIC_MODEL_LOW: "a", ANTHROPIC_MODEL_MEDIUM: undefined, ANTHROPIC_MODEL_HIGH: undefined });
  });
});

describe("resolveMaxOutputTokens (COST-03)", () => {
  it("keeps the original 16 000 ceiling unless a task declares its own", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16_000);
    expect(resolveMaxOutputTokens(low)).toBe(16_000);
    expect(resolveMaxOutputTokens(pinned)).toBe(800);
    expect(resolveMaxOutputTokens({ maxOutputTokens: 0 })).toBe(16_000);
    expect(resolveMaxOutputTokens({ maxOutputTokens: NaN })).toBe(16_000);
    expect(resolveMaxOutputTokens({ maxOutputTokens: 1234.7 })).toBe(1234);
  });
});

describe("MockProvider pricing follows routing", () => {
  it("is unchanged by default: Opus pricing for every tier", async () => {
    const p = new MockProvider({ routing: {} });
    const r = await p.run(low, { q: "hi" });
    expect(r.usage.model).toBe(DEFAULT_MODEL);
    expect(r.usage.costUsd).toBeCloseTo(estimateCostUsd(r.usage.inputTokens, r.usage.outputTokens, DEFAULT_MODEL), 10);
  });
  it("prices a routed low-effort task at the cheaper model", async () => {
    const p = new MockProvider({ routing: { ANTHROPIC_MODEL_LOW: "claude-haiku-5-5" } });
    const r = await p.run(low, { q: "hi" });
    expect(r.usage.model).toBe("claude-haiku-5-5");
    expect(r.usage.costUsd).toBeCloseTo(estimateCostUsd(r.usage.inputTokens, r.usage.outputTokens, "claude-haiku-5-5"), 10);
    expect(r.usage.costUsd).toBeLessThan(estimateCostUsd(r.usage.inputTokens, r.usage.outputTokens, DEFAULT_MODEL) / 20);
    const m = await p.run(medium, { q: "hi" });
    expect(m.usage.model).toBe(DEFAULT_MODEL);
  });
});

describe("AnthropicProvider request shape", () => {
  const stub = (capture: (params: Record<string, unknown>) => void) =>
    ({
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            capture(params);
            return { stop_reason: "end_turn", parsed_output: { label: "ok" }, model: params["model"], usage: { input_tokens: 10, output_tokens: 5 }, content: [] };
          },
        },
      },
    }) as unknown as Anthropic;

  it("sends the configured model and the 16 000 ceiling by default (unchanged behaviour)", async () => {
    let sent: Record<string, unknown> = {};
    const p = new AnthropicProvider({ client: stub((x) => (sent = x)), model: DEFAULT_MODEL, routing: {} });
    const r = await p.run(low, { q: "hi" });
    expect(sent["model"]).toBe(DEFAULT_MODEL);
    expect(sent["max_tokens"]).toBe(16_000);
    expect(r.usage.costUsd).toBeCloseTo(estimateCostUsd(10, 5, DEFAULT_MODEL), 10);
  });
  it("routes low-effort tasks and honours a task's output ceiling", async () => {
    let sent: Record<string, unknown> = {};
    const p = new AnthropicProvider({ client: stub((x) => (sent = x)), model: DEFAULT_MODEL, routing: { ANTHROPIC_MODEL_LOW: "claude-haiku-5-5" } });
    const r = await p.run(low, { q: "hi" });
    expect(sent["model"]).toBe("claude-haiku-5-5");
    expect(r.usage.costUsd).toBeCloseTo(estimateCostUsd(10, 5, "claude-haiku-5-5"), 10);
    await p.run(pinned, { q: "hi" });
    expect(sent["model"]).toBe("claude-sonnet-5-5");
    expect(sent["max_tokens"]).toBe(800);
  });
  it("pricing table matches the published first-party prices (USD per MTok)", () => {
    expect(MODEL_PRICING).toEqual({
      "claude-opus-5-5": { input: 4, output: 20 },
      "claude-sonnet-5-5": { input: 2, output: 10 },
      "claude-haiku-5-5": { input: 0.1, output: 0.5 },
    });
  });
});

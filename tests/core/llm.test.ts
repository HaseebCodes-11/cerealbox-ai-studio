import { describe, expect, it } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMOutputError, MockProvider, defineTask, getProvider, stableStringify } from "../../src/core/llm";
import { AnthropicProvider } from "../../src/core/llm/anthropic";
import { MODEL_PRICING } from "../../src/core/cost";

const EchoSchema = z.object({ greeting: z.string(), n: z.number() });
const echoTask = defineTask<{ name: string; n: number }, z.infer<typeof EchoSchema>>({
  name: "test.echo",
  description: "echo",
  schema: EchoSchema,
  system: "You echo.",
  prompt: (i) => `Say hello to ${i.name}`,
  mock: (i, { rng }) => ({ greeting: `hello ${i.name}`, n: i.n + rng.int(0, 1000) }),
});

describe("MockProvider", () => {
  it("returns deterministic output for the same input and seed", async () => {
    const a = await new MockProvider({ seed: "s" }).run(echoTask, { name: "Ada", n: 1 });
    const b = await new MockProvider({ seed: "s" }).run(echoTask, { name: "Ada", n: 1 });
    expect(a.output).toEqual(b.output);
    expect(a.output.greeting).toBe("hello Ada");
  });

  it("changes output when the seed or input changes", async () => {
    const a = await new MockProvider({ seed: "s1" }).run(echoTask, { name: "Ada", n: 1 });
    const b = await new MockProvider({ seed: "s2" }).run(echoTask, { name: "Ada", n: 1 });
    const c = await new MockProvider({ seed: "s1" }).run(echoTask, { name: "Ada", n: 2 });
    expect(a.output.n).not.toBe(b.output.n);
    expect(a.output.n).not.toBe(c.output.n);
  });

  it("reports estimated usage and cost for the pricing model", async () => {
    const r = await new MockProvider({ pricingModel: "claude-sonnet-5-5" }).run(echoTask, { name: "Ada", n: 1 });
    expect(r.usage.provider).toBe("mock");
    expect(r.usage.model).toBe("claude-sonnet-5-5");
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    const expected = (r.usage.inputTokens * MODEL_PRICING["claude-sonnet-5-5"]!.input + r.usage.outputTokens * MODEL_PRICING["claude-sonnet-5-5"]!.output) / 1e6;
    expect(r.usage.costUsd).toBeCloseTo(expected, 10);
    expect(r.taskName).toBe("test.echo");
  });

  it("rejects a mock that violates the schema", async () => {
    const bad = defineTask<Record<string, never>, z.infer<typeof EchoSchema>>({
      ...echoTask,
      name: "test.bad",
      prompt: () => "",
      mock: () => ({ greeting: 42 as unknown as string, n: 1 }),
    });
    await expect(new MockProvider().run(bad, {})).rejects.toBeInstanceOf(LLMOutputError);
  });
});

describe("stableStringify", () => {
  it("orders keys so equivalent objects hash the same", () => {
    expect(stableStringify({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [3, { c: 2, d: 1 }], b: 1 }));
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("x")).toBe('"x"');
  });
});

describe("getProvider", () => {
  it("defaults to the mock provider", async () => {
    expect((await getProvider({})).name).toBe("mock");
    expect((await getProvider({ LLM_PROVIDER: "MOCK" })).name).toBe("mock");
  });

  it("throws on an unknown provider", async () => {
    await expect(getProvider({ LLM_PROVIDER: "openai" })).rejects.toThrow(/Unknown LLM_PROVIDER/);
  });

  it("builds the Anthropic provider when requested", async () => {
    const p = await getProvider({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" });
    expect(p.name).toBe("anthropic");
  });
});

describe("AnthropicProvider (stubbed client)", () => {
  function stub(response: Record<string, unknown>, capture?: (params: unknown) => void) {
    const client = { beta: { messages: { parse: async (params: unknown) => { capture?.(params); return response; } } } } as unknown as Anthropic;
    return new AnthropicProvider({ client, model: "claude-opus-5-5" });
  }
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 };

  it("returns parsed, schema-validated output with usage and cost", async () => {
    let sent: Record<string, unknown> = {};
    const p = stub({ stop_reason: "end_turn", parsed_output: { greeting: "hello Ada", n: 7 }, usage, model: "claude-opus-5-5", content: [] }, (params) => (sent = params as Record<string, unknown>));
    const r = await p.run(echoTask, { name: "Ada", n: 1 });
    expect(r.output).toEqual({ greeting: "hello Ada", n: 7 });
    expect(r.usage.inputTokens).toBe(120);
    expect(r.usage.outputTokens).toBe(50);
    expect(r.usage.costUsd).toBeCloseTo((120 * 4 + 50 * 20) / 1e6, 10);
    expect(sent["model"]).toBe("claude-opus-5-5");
    expect(sent["fallbacks"]).toBe("default");
    expect(sent["betas"]).toEqual(["server-side-fallback-2026-07-01"]);
    expect((sent["output_config"] as Record<string, unknown>)["effort"]).toBe("medium");
    expect(JSON.stringify(sent["system"])).toContain("ephemeral");
  });

  it("throws a clear error on refusal", async () => {
    const p = stub({ stop_reason: "refusal", stop_details: { type: "refusal", explanation: "policy" }, parsed_output: null, usage, model: "m", content: [] });
    await expect(p.run(echoTask, { name: "Ada", n: 1 })).rejects.toThrow(/declined/);
  });

  it("throws on truncation and on unparseable output", async () => {
    await expect(stub({ stop_reason: "max_tokens", parsed_output: null, usage, model: "m", content: [] }).run(echoTask, { name: "A", n: 1 })).rejects.toThrow(/truncated/);
    await expect(stub({ stop_reason: "end_turn", parsed_output: null, usage, model: "m", content: [] }).run(echoTask, { name: "A", n: 1 })).rejects.toThrow(/could not be parsed/);
  });

  it("re-validates parsed output against the task schema", async () => {
    const p = stub({ stop_reason: "end_turn", parsed_output: { greeting: 1, n: "x" }, usage, model: "m", content: [] });
    await expect(p.run(echoTask, { name: "A", n: 1 })).rejects.toThrow(/schema validation/);
  });
});

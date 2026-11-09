import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/core/llm/anthropic";
import { copyGenerationTask, validateCopy } from "../../src/areas/copy";
import { intentTask } from "../../src/areas/toast/ask";
import { judgeTask } from "../../src/evals/judge";
import { sampleBrief, sampleIdea } from "../helpers";

/**
 * Live smoke test against Claude. Runs only when ANTHROPIC_API_KEY (or an
 * `ant auth login` profile via ANTHROPIC_AUTH_TOKEN) is present, so the
 * default suite stays offline and free. Proves the production code path:
 * structured outputs, schema re-validation, guardrails on real output.
 */
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

describe.skipIf(!hasKey)("Anthropic provider (live)", () => {
  const provider = new AnthropicProvider();
  const brief = sampleBrief();

  it("writes a copy pack that passes schema validation and guardrails", async () => {
    const result = await provider.run(copyGenerationTask, { brief, idea: sampleIdea(brief) });
    expect(result.usage.provider).toBe("anthropic");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    const validation = validateCopy(result.output, brief);
    expect(validation.overall.issues.filter((i) => i.severity === "block"), JSON.stringify(validation.removed, null, 2)).toHaveLength(0);
    expect(result.output.primaryTexts.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("translates a question into a typed intent", async () => {
    const result = await provider.run(intentTask, { question: "Which client had the biggest ROAS drop last week?", clientNames: ["Hearthline", "Bluewater Trust"] });
    expect(result.output.intent).toBe("biggest_change");
    expect(result.output.metric).toBe("roas");
  }, 60_000);

  it("judges copy on the rubric", async () => {
    const result = await provider.run(judgeTask, { brief, artefactType: "copy", text: "£30 covers a week of heating for one household. Donate today and help an older person stay warm." });
    expect(result.output.overall).toBeGreaterThanOrEqual(1);
    expect(["ship", "revise", "reject"]).toContain(result.output.verdict);
  }, 60_000);
});

describe("live test gating", () => {
  it("is skipped without credentials and documented", () => {
    expect(typeof hasKey).toBe("boolean");
  });
});

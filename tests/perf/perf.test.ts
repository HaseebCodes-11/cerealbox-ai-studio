/**
 * Performance regression guards. Thresholds are ~10× the numbers measured in
 * docs/AUDIT.md on a laptop so they never flake on a slow CI runner, but a
 * quadratic regression (which would be 100×+) still fails here.
 */
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scaledDataset } from "../../scripts/bench";
import { MockProvider } from "../../src/core/llm";
import { parseBrief } from "../../src/core/brief";
import { checkText } from "../../src/core/guardrails";
import { RulesConfigSchema, buildWindows, evaluateRules } from "../../src/areas/media-buyer";
import { generateInsights, comparePeriods } from "../../src/areas/toast";
import { runCampaignPipeline } from "../../src/orchestrator";

const ms = async (fn: () => unknown | Promise<unknown>) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

describe("performance budgets", () => {
  const asOf = "2026-11-08";
  const data = scaledDataset(30, 365, asOf);

  it("dataset is at the intended scale", () => {
    expect(data.clients).toHaveLength(30);
    expect(data.metrics.length).toBeGreaterThan(25_000);
  });

  it("media buyer windows + rules over a year of 30 clients stay under 1.5 s", async () => {
    const config = RulesConfigSchema.parse({});
    expect(await ms(() => evaluateRules(buildWindows(data, asOf, config), config, asOf))).toBeLessThan(1500);
  });

  it("Toast insights over a year of 30 clients stay under 1.5 s", async () => {
    expect(await ms(() => generateInsights(data, asOf))).toBeLessThan(1500);
    expect(await ms(() => comparePeriods(data, "adset", asOf, 7))).toBeLessThan(500);
  });

  it("guardrails check 200 × 10 KB in under 4 s", async () => {
    const long = "Donate today and help an older person stay warm. £30 covers a week of heating for one household. ".repeat(50);
    expect(await ms(() => {
      for (let i = 0; i < 200; i++) checkText(long, { allowedFacts: ["£30 covers a week of heating for one household"], avoidWords: ["vulnerable", "the elderly", "victims"] });
    })).toBeLessThan(4000);
  });

  it("a full mock campaign pipeline runs in under 2 s", async () => {
    const brief = parseBrief(JSON.parse(readFileSync("samples/brief-winter-warmth.json", "utf8")));
    expect(await ms(() => runCampaignPipeline({ brief, provider: new MockProvider() }))).toBeLessThan(2000);
  });
});

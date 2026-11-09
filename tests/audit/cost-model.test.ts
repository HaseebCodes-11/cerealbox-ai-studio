/**
 * COST-01 guard: prompt caching only engages above a per-model minimum prefix
 * length. This test records, per task, whether the system prompt is cacheable
 * so that the claim in the docs stays honest and a future prompt restructure
 * that crosses the threshold shows up as a deliberate change here.
 */
import { describe, expect, it } from "vitest";
import { CACHE_MIN_TOKENS, DEFAULT_MODEL, estimateCostUsd, estimateTokens, formatUsd, promptCacheability } from "../../src/core/cost";
import { clientReplyTask } from "../../src/areas/comms";
import { copyGenerationTask } from "../../src/areas/copy";
import { ideaGenerationTask } from "../../src/areas/ideas";
import { landingSpecTask } from "../../src/areas/landing";
import { dailyBriefTask } from "../../src/areas/media-buyer";
import { clientReportTask } from "../../src/areas/reporting";
import { scriptGenerationTask } from "../../src/areas/scripts";
import { creativeConceptTask } from "../../src/areas/static";
import { intentTask, narrativeTask } from "../../src/areas/toast";
import { personaTask } from "../../src/areas/ugc";
import { clipSelectionTask } from "../../src/areas/video";
import { judgeTask } from "../../src/evals/judge";

const tasks = [clientReplyTask, copyGenerationTask, ideaGenerationTask, landingSpecTask, dailyBriefTask, clientReportTask, scriptGenerationTask, creativeConceptTask, intentTask, narrativeTask, personaTask, clipSelectionTask, judgeTask];

describe("cost model", () => {
  it("prices a call from tokens and formats small amounts with 4 decimals", () => {
    expect(estimateCostUsd(1_000_000, 0, "claude-opus-5-5")).toBe(4);
    expect(estimateCostUsd(0, 1_000_000, "claude-opus-5-5")).toBe(20);
    expect(estimateCostUsd(1_000_000, 1_000_000, "claude-haiku-5-5")).toBeCloseTo(0.6, 10);
    expect(estimateCostUsd(1000, 1000, "unknown-model")).toBe(estimateCostUsd(1000, 1000, DEFAULT_MODEL));
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("knows the cache minimum for every priced model", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) expect(CACHE_MIN_TOKENS[model]).toBe(512);
  });

  it("reports honestly that no current system prompt reaches the cacheable minimum (COST-01)", () => {
    expect(tasks).toHaveLength(13);
    const report = tasks.map((t) => ({ name: t.name, ...promptCacheability(t.system) }));
    for (const r of report) {
      expect(r.minimumTokens).toBe(512);
      // If a prompt grows past the minimum this assertion fails on purpose: update docs/AUDIT.md COST-01 and this list.
      expect(r.cacheable, `${r.name} (${r.estimatedTokens} tokens)`).toBe(false);
    }
    // ...and the helper itself says yes once a prompt is long enough.
    expect(promptCacheability("x".repeat(512 * 4)).cacheable).toBe(true);
    expect(promptCacheability("x".repeat(512 * 4 - 4)).cacheable).toBe(false);
  });
});

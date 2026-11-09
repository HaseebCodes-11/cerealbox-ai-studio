import { describe, expect, it } from "vitest";
import { AGENT_SCENARIOS, RED_TEAM_CASES, runAgentRecall, runPipelineScorecard, runRedTeam } from "../src/evals/suite";
import { provider, sampleBrief } from "./helpers";

const brief = sampleBrief();

describe("eval harness", () => {
  it("every red-team case behaves as specified", () => {
    const results = runRedTeam(brief);
    expect(results).toHaveLength(RED_TEAM_CASES.length);
    for (const r of results) expect(r.passed, `${r.name}: missing ${r.missing.join(",")} okMismatch=${r.okMismatch}`).toBe(true);
  });

  it("red team detects a regression if a rule stops firing", () => {
    const results = runRedTeam(brief, [{ name: "impossible", text: "Donate today.", expectRules: ["claims.guarantee"], expectOk: true }]);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.missing).toEqual(["claims.guarantee"]);
  });

  it("pipeline scorecard is complete with everything passing", async () => {
    const score = await runPipelineScorecard(brief, provider());
    expect(score.status).toBe("complete");
    expect(score.copyScore).toBeGreaterThanOrEqual(95);
    expect(score.copyVariantsKept).toBe(score.copyVariantsTotal);
    expect(score.creativesPassing).toBe(score.creativesTotal);
    expect(score.scriptsPassing).toBe(score.scriptsTotal);
    expect(score.landingPassing).toBe(score.landingTotal);
    expect(score.duplicateIdeas).toBe(0);
    expect(score.ideaAngles).toBe(10);
    expect(score.gatesApproved).toBe(score.gatesTotal);
    expect(score.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("agent recall is 100% with no findings outside the injected scenarios", async () => {
    const recall = await runAgentRecall(provider());
    expect(recall.detected).toHaveLength(AGENT_SCENARIOS.length);
    expect(recall.recall).toBe(1);
    expect(recall.falsePositives).toBe(0);
    expect(recall.totalRecommendations).toBe(AGENT_SCENARIOS.length);
  });
});

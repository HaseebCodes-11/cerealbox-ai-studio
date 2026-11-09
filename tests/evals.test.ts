import { describe, expect, it } from "vitest";
import { AGENT_SCENARIOS, RED_TEAM_CASE_COUNT, redTeamCases, runAgentRecall, runPipelineScorecard, runRedTeam } from "../src/evals/suite";
import { allSampleBriefs, provider, sampleBrief } from "./helpers";

const brief = sampleBrief();

describe("eval harness", () => {
  it("every red-team case behaves as specified, for every sample brief", () => {
    for (const b of allSampleBriefs()) {
      const results = runRedTeam(b);
      expect(results).toHaveLength(RED_TEAM_CASE_COUNT);
      expect(redTeamCases(b).find((c) => c.name === "banned brand word")!.text).toContain(b.client.voice.avoid[0]!);
      for (const r of results) expect(r.passed, `${b.client.name} / ${r.name}: missing ${r.missing.join(",")} okMismatch=${r.okMismatch}`).toBe(true);
    }
  });

  it("pipeline scorecard is complete for every sample brief", async () => {
    for (const b of allSampleBriefs()) {
      const score = await runPipelineScorecard(b, provider());
      expect(score.status, b.client.name).toBe("complete");
      expect(score.creativesPassing, b.client.name).toBe(score.creativesTotal);
      expect(score.scriptsPassing, b.client.name).toBe(score.scriptsTotal);
      expect(score.landingPassing, b.client.name).toBe(score.landingTotal);
      expect(score.copyVariantsKept, b.client.name).toBe(score.copyVariantsTotal);
    }
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

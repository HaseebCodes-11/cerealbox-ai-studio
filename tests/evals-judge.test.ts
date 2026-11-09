import { describe, expect, it } from "vitest";
import { JudgementSchema, heuristicJudgement, judgePackage, judgeTask } from "../src/evals/judge";
import { runCampaignPipeline } from "../src/orchestrator";
import { allSampleBriefs, provider, sampleBrief } from "./helpers";

const brief = sampleBrief();

describe("heuristic judge", () => {
  it("rewards specific, clean, human copy and punishes vague or unsafe copy", () => {
    const good = heuristicJudgement(brief, "copy", "£30 covers a week of heating for one household. My nan heated one room last winter and told nobody. Donate today and help an older person.");
    const vague = heuristicJudgement(brief, "copy", "We make a difference in communities across the country through our important work. Support us.");
    const unsafe = heuristicJudgement(brief, "copy", "We guarantee the elderly will be warm. 100% of your donation goes to them.");
    expect(JudgementSchema.safeParse(good).success).toBe(true);
    expect(good.overall).toBeGreaterThan(vague.overall);
    expect(good.verdict).toBe("ship");
    expect(vague.specificity).toBeLessThan(good.specificity);
    expect(vague.emotionalPull).toBeLessThan(good.emotionalPull);
    expect(unsafe.brandFit).toBeLessThan(good.brandFit);
    expect(unsafe.verdict).not.toBe("ship");
    expect(unsafe.weaknesses.some((w) => /blocked/i.test(w))).toBe(true);
  });

  it("penalises long sentences and dense prose", () => {
    const dense = heuristicJudgement(brief, "landing", "Notwithstanding multifaceted socioeconomic determinants and the heterogeneous distribution of thermal deprivation across geriatric populations in post-industrial conurbations throughout the northern regions of the country, our organisation's evidence-based interventions demonstrably ameliorate measurable outcomes over time.");
    expect(dense.clarity).toBeLessThanOrEqual(5);
    expect(dense.weaknesses.some((w) => /sentence/i.test(w))).toBe(true);
  });

  it("the task prompt carries the brief context and runs through the provider", async () => {
    const prompt = judgeTask.prompt({ brief, artefactType: "idea", text: "x" });
    expect(prompt).toContain("Hearthline");
    expect(prompt).toContain("Artefact type: idea");
    const r = await provider().run(judgeTask, { brief, artefactType: "copy", text: "£30 covers a week of heating for one household. Donate today." });
    expect(r.output.overall).toBeGreaterThan(5);
  });
});

describe("judgePackage", () => {
  it("judges idea, copy, script and landing for every sample brief with no rejects", async () => {
    for (const b of allSampleBriefs()) {
      const pkg = await runCampaignPipeline({ brief: b, provider: provider() });
      const before = pkg.audit.totals().llmCalls;
      const result = await judgePackage(pkg, provider());
      expect(result.items.map((i) => i.artefactType)).toEqual(["idea", "copy", "script", "landing"]);
      expect(result.verdictCounts.reject, `${b.client.name}: ${JSON.stringify(result.items.map((i) => [i.label, i.judgement.overall]))}`).toBe(0);
      expect(result.meanOverall).toBeGreaterThanOrEqual(6);
      expect(pkg.audit.totals().llmCalls).toBe(before + 4);
      expect(result.verdictCounts.ship + result.verdictCounts.revise + result.verdictCounts.reject).toBe(4);
    }
  });
});

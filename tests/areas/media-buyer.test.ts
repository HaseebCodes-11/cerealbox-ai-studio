import { describe, expect, it } from "vitest";
import { derive, sumMetrics, type Derived } from "../../src/core/ads";
import {
  MockMetaAdsClient,
  RulesConfigSchema,
  buildWindows,
  dailyBriefTask,
  decideExecution,
  dedupeByEntityAndType,
  describe as describeRec,
  evaluateRules,
  formatSlackAlert,
  recommendationsToMarkdown,
  ruleCpaSpike,
  ruleCreativeFatigue,
  ruleLearningLimited,
  ruleRoasFloor,
  ruleScaleWinner,
  ruleTrackingBreak,
  ruleZeroConversionAd,
  runMediaBuyerAgent,
  type AdsetWindow,
  type Recommendation,
} from "../../src/areas/media-buyer";
import { generateMockDataset } from "../../src/areas/toast";
import { provider } from "../helpers";

const config = RulesConfigSchema.parse({});
const asOf = "2026-11-08";

function metrics(partial: Partial<Derived>): Derived {
  return { ...derive(sumMetrics([])), ...partial };
}

function window(overrides: Partial<AdsetWindow> = {}): AdsetWindow {
  return {
    adsetId: "as-1",
    campaignId: "c-1",
    clientId: "client-1",
    name: "Test ad set",
    dailyBudgetGbp: 100,
    status: "ACTIVE",
    learningStatus: "active",
    targetRoas: 3,
    targetCpaGbp: 20,
    recent: metrics({ spend: 700, conversions: 35, cpa: 20, roas: 3, revenue: 2100, linkClicks: 1400 }),
    previous: metrics({ spend: 700, conversions: 35, cpa: 20, roas: 3, revenue: 2100, linkClicks: 1400 }),
    recent3: metrics({ spend: 300, conversions: 15, linkClicks: 600 }),
    ads: [],
    ...overrides,
  };
}

describe("individual rules", () => {
  it("tracking break: spend and clicks but zero conversions after a converting week", () => {
    const w = window({ recent3: metrics({ spend: 300, conversions: 0, linkClicks: 600 }), previous: metrics({ conversions: 20 }) });
    const recs = ruleTrackingBreak(w, config, asOf);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.type).toBe("investigate_tracking");
    expect(recs[0]!.risk).toBe("human");
    expect(recs[0]!.proposedChange).toBeUndefined();
    expect(ruleTrackingBreak(window(), config, asOf)).toEqual([]);
    expect(ruleTrackingBreak(window({ status: "PAUSED", recent3: metrics({ spend: 300, conversions: 0, linkClicks: 600 }) }), config, asOf)).toEqual([]);
  });

  it("CPA spike: recommends a 20% budget trim as an approve-tier change", () => {
    const w = window({ recent: metrics({ spend: 700, conversions: 20, cpa: 35, roas: 2 }), previous: metrics({ spend: 700, conversions: 35, cpa: 20 }) });
    const recs = ruleCpaSpike(w, config, asOf);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.type).toBe("decrease_budget");
    expect(recs[0]!.risk).toBe("approve");
    expect(recs[0]!.proposedChange).toEqual({ field: "daily_budget_gbp", from: 100, to: 80 });
  });

  it("CPA spike ignores low spend, zero conversions and CPAs still inside target", () => {
    expect(ruleCpaSpike(window({ recent: metrics({ spend: 50, conversions: 2, cpa: 35 }) }), config, asOf)).toEqual([]);
    expect(ruleCpaSpike(window({ recent: metrics({ spend: 700, conversions: 0, cpa: 0 }) }), config, asOf)).toEqual([]);
    expect(ruleCpaSpike(window({ recent: metrics({ spend: 700, conversions: 50, cpa: 16 }), previous: metrics({ conversions: 70, cpa: 10 }) }), config, asOf)).toEqual([]);
  });

  it("ROAS floor: mild miss trims budget, severe miss proposes a pause for a human", () => {
    const mild = ruleRoasFloor(window({ recent: metrics({ spend: 700, conversions: 30, roas: 1.8 }) }), config, asOf);
    expect(mild[0]!.type).toBe("decrease_budget");
    expect(mild[0]!.risk).toBe("approve");
    const severe = ruleRoasFloor(window({ recent: metrics({ spend: 700, conversions: 10, roas: 0.8 }) }), config, asOf);
    expect(severe[0]!.type).toBe("pause_adset");
    expect(severe[0]!.risk).toBe("human");
    expect(severe[0]!.proposedChange).toEqual({ field: "status", from: "ACTIVE", to: "PAUSED" });
    expect(ruleRoasFloor(window({ recent: metrics({ spend: 700, conversions: 30, roas: 2.5 }) }), config, asOf)).toEqual([]);
  });

  it("scale winner: +20% budget within caps, only when learning is complete", () => {
    const w = window({ recent: metrics({ spend: 700, conversions: 40, roas: 4.5, cpa: 15 }) });
    const recs = ruleScaleWinner(w, config, asOf);
    expect(recs[0]!.type).toBe("increase_budget");
    expect(recs[0]!.proposedChange).toEqual({ field: "daily_budget_gbp", from: 100, to: 120 });
    expect(ruleScaleWinner({ ...w, learningStatus: "learning" }, config, asOf)).toEqual([]);
    expect(ruleScaleWinner({ ...w, dailyBudgetGbp: 1000 }, config, asOf)).toEqual([]);
    expect(ruleScaleWinner({ ...w, recent: metrics({ spend: 700, conversions: 40, roas: 4.5, cpa: 25 }) }, config, asOf)).toEqual([]);
  });

  it("creative fatigue: frequency over cap plus CTR collapse at ad level", () => {
    const ad = { adId: "ad-1", name: "Static A", creativeType: "static", launchedOn: "2026-09-01", recent: metrics({ spend: 200, frequency: 4.2, ctr: 0.7, impressions: 20000 }), previous: metrics({ spend: 200, frequency: 1.8, ctr: 1.4, impressions: 20000 }) };
    const recs = ruleCreativeFatigue(window({ ads: [ad] }), config, asOf);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.entity).toMatchObject({ level: "ad", id: "ad-1" });
    expect(recs[0]!.type).toBe("refresh_creative");
    const fresh = { ...ad, recent: metrics({ spend: 200, frequency: 1.9, ctr: 1.3, impressions: 20000 }) };
    expect(ruleCreativeFatigue(window({ ads: [fresh] }), config, asOf)).toEqual([]);
  });

  it("zero-conversion ad: pause after spending 3x target CPA while siblings convert", () => {
    const dead = { adId: "ad-2", name: "Video B", creativeType: "video", launchedOn: "2026-11-01", recent: metrics({ spend: 70, conversions: 0 }), previous: metrics({}) };
    const recs = ruleZeroConversionAd(window({ ads: [dead] }), config, asOf);
    expect(recs[0]!.type).toBe("pause_ad");
    expect(recs[0]!.risk).toBe("approve");
    const young = { ...dead, recent: metrics({ spend: 40, conversions: 0 }) };
    expect(ruleZeroConversionAd(window({ ads: [young] }), config, asOf)).toEqual([]);
    expect(ruleZeroConversionAd(window({ ads: [dead], recent: metrics({ spend: 700, conversions: 0 }) }), config, asOf)).toEqual([]);
  });

  it("learning limited: trusts Meta's status and only applies the heuristic while learning", () => {
    expect(ruleLearningLimited(window({ learningStatus: "learning_limited" }), config, asOf)[0]!.type).toBe("exit_learning_limited");
    expect(ruleLearningLimited(window({ learningStatus: "learning", recent: metrics({ spend: 700, conversions: 10 }) }), config, asOf)).toHaveLength(1);
    expect(ruleLearningLimited(window({ learningStatus: "learning", recent: metrics({ spend: 700, conversions: 60 }) }), config, asOf)).toEqual([]);
    expect(ruleLearningLimited(window({ learningStatus: "active", recent: metrics({ spend: 700, conversions: 10 }) }), config, asOf)).toEqual([]);
  });
});

describe("evaluateRules", () => {
  it("suppresses every other finding on an ad set with a tracking break", () => {
    const w = window({
      recent3: metrics({ spend: 300, conversions: 0, linkClicks: 600 }),
      previous: metrics({ spend: 700, conversions: 35, cpa: 20 }),
      recent: metrics({ spend: 700, conversions: 15, roas: 1, cpa: 45 }),
    });
    const recs = evaluateRules([w], config, asOf);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.rule).toBe("tracking-break");
  });

  it("dedupes two rules proposing the same change, keeping the more confident", () => {
    const a: Recommendation = { id: "a", rule: "cpa-spike", type: "decrease_budget", entity: { level: "adset", id: "x", name: "x", clientId: "c" }, title: "", rationale: "", evidence: {}, risk: "approve", confidence: 0.7, status: "proposed", createdOn: asOf };
    const b: Recommendation = { ...a, id: "b", rule: "roas-floor", confidence: 0.65 };
    const c: Recommendation = { ...a, id: "c", type: "increase_budget" };
    expect(dedupeByEntityAndType([a, b, c]).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("sorts human-tier items first, then by confidence", () => {
    const w = window({ recent: metrics({ spend: 700, conversions: 10, roas: 0.8, cpa: 70 }), previous: metrics({ spend: 700, conversions: 35, cpa: 20 }) });
    const recs = evaluateRules([w], config, asOf);
    expect(recs[0]!.risk).toBe("human");
    for (let i = 1; i < recs.length; i++) {
      const order = (r: Recommendation) => (r.risk === "human" ? 3 : r.risk === "approve" ? 2 : 1);
      expect(order(recs[i - 1]!)).toBeGreaterThanOrEqual(order(recs[i]!));
    }
  });
});

describe("execution policy", () => {
  const budget: Recommendation = { id: "r1", rule: "scale-winner", type: "increase_budget", entity: { level: "adset", id: "as", name: "as", clientId: "c" }, title: "", rationale: "", evidence: {}, risk: "approve", confidence: 0.75, proposedChange: { field: "daily_budget_gbp", from: 100, to: 120 }, status: "proposed", createdOn: asOf };
  const pauseAd: Recommendation = { ...budget, id: "r2", type: "pause_ad", proposedChange: { field: "status", from: "ACTIVE", to: "PAUSED" } };
  const human: Recommendation = { ...budget, id: "r3", risk: "human", type: "pause_adset", proposedChange: { field: "status", from: "ACTIVE", to: "PAUSED" } };
  const notify: Recommendation = { ...budget, id: "r4", type: "investigate_tracking", proposedChange: undefined };

  it("assist mode never executes without an explicit approval", () => {
    expect(decideExecution(budget, "assist", new Set(), config)).toBe("skip");
    expect(decideExecution(budget, "assist", new Set(["r1"]), config)).toBe("approved");
  });

  it("copilot executes only auto-tier; autopilot executes small approve-tier changes", () => {
    expect(decideExecution(budget, "copilot", new Set(), config)).toBe("skip");
    expect(decideExecution({ ...budget, risk: "auto" }, "copilot", new Set(), config)).toBe("auto");
    expect(decideExecution(budget, "autopilot", new Set(), config)).toBe("auto");
    expect(decideExecution(pauseAd, "autopilot", new Set(), config)).toBe("auto");
  });

  it("autopilot respects budget caps and never pauses ad sets on its own", () => {
    const big = { ...budget, proposedChange: { field: "daily_budget_gbp" as const, from: 100, to: 150 } };
    expect(decideExecution(big, "autopilot", new Set(), config)).toBe("skip");
    const overCap = { ...budget, proposedChange: { field: "daily_budget_gbp" as const, from: 950, to: 1100 } };
    expect(decideExecution(overCap, "autopilot", new Set(), config)).toBe("skip");
    expect(decideExecution(human, "autopilot", new Set(), config)).toBe("skip");
    expect(decideExecution(human, "autopilot", new Set(["r3"]), config)).toBe("approved");
    expect(decideExecution(notify, "autopilot", new Set(["r4"]), config)).toBe("skip");
  });
});

describe("agent run on the mock dataset", () => {
  const data = generateMockDataset({ asOf });

  it("finds every injected scenario and nothing else", async () => {
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist" });
    const keys = run.recommendations.map((r) => `${r.rule}:${r.entity.id}`).sort();
    expect(keys).toEqual(
      [
        "scale-winner:hearthline-c1-as1",
        "creative-fatigue:hearthline-c1-as2-ad1",
        "tracking-break:bluewater-c1-as1",
        "cpa-spike:kindred-c1-as1",
        "roas-floor:northlight-c1-as1",
        "zero-conversion-ad:paws-c1-as1-ad2",
        "learning-limited:brightstart-c1-as1",
      ].sort(),
    );
    expect(run.actions).toEqual([]);
    expect(run.briefs).toHaveLength(data.clients.length);
    expect(run.alerts.some((a) => a.severity === "critical" && a.title.includes("tracking"))).toBe(true);
    expect(run.audit.totals().llmCalls).toBe(data.clients.length);
  });

  it("dry run executes nothing against the ads client but records intended actions", async () => {
    const client = new MockMetaAdsClient();
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "autopilot", dryRun: true });
    expect(run.actions.length).toBeGreaterThan(0);
    expect(run.actions.every((a) => a.dryRun && a.detail.startsWith("DRY RUN"))).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it("autopilot live run executes the allowed changes and marks statuses", async () => {
    const client = new MockMetaAdsClient();
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "autopilot", dryRun: false });
    const executed = run.recommendations.filter((r) => r.status === "auto_executed");
    // creative-fatigue proposes a pause but is not auto-executed: a replacement creative must be live first.
    expect(executed.map((r) => r.rule).sort()).toEqual(["cpa-spike", "scale-winner", "zero-conversion-ad"]);
    expect(run.recommendations.find((r) => r.rule === "creative-fatigue")?.status).toBe("proposed");
    expect(client.calls.find((c) => c.method === "updateAdsetBudget" && c.id === "hearthline-c1-as1")?.value).toBe(144);
    expect(run.recommendations.filter((r) => r.risk === "human").every((r) => r.status === "proposed")).toBe(true);
  });

  it("an explicit approval executes a human-tier pause and failures are recorded", async () => {
    const client = new MockMetaAdsClient(new Set(["paws-c1-as1-ad2"]));
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "autopilot", dryRun: false, approvedIds: [`roas-floor:northlight-c1-as1:${asOf}`] });
    expect(run.recommendations.find((r) => r.rule === "roas-floor")?.status).toBe("executed");
    expect(client.calls.some((c) => c.method === "pauseAdset" && c.id === "northlight-c1-as1")).toBe(true);
    const failed = run.recommendations.find((r) => r.entity.id === "paws-c1-as1-ad2");
    expect(failed?.status).toBe("failed");
    expect(run.actions.find((a) => a.recommendationId === failed?.id)?.ok).toBe(false);
  });

  it("client filter limits the run and the ads client is idempotent", async () => {
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist", clientFilter: ["hearthline"] });
    expect(run.recommendations.every((r) => r.entity.clientId === "hearthline")).toBe(true);
    expect(run.briefs).toHaveLength(1);
    const client = new MockMetaAdsClient();
    await client.updateAdsetBudget("x", 50);
    const again = await client.updateAdsetBudget("x", 50);
    expect(again.detail).toMatch(/no-op/);
    expect(client.calls).toHaveLength(1);
    await client.pauseAd("a");
    expect((await client.pauseAd("a")).detail).toMatch(/already paused/);
  });

  it("writes briefs that reference the findings and formats Slack alerts and markdown", async () => {
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist" });
    const bluewater = run.briefs.find((b) => b.clientId === "bluewater")!;
    expect(bluewater.brief.headline).toMatch(/decision/);
    expect(bluewater.brief.priorities[0]!.recommendationId).toContain("tracking-break");
    const steady = run.briefs.find((b) => b.clientId === "kindred")!;
    expect(steady.brief.headline).toMatch(/quick win/);
    const slack = formatSlackAlert(run.alerts[0]!);
    expect(slack).toMatch(/^:(rotating_light|warning):/);
    expect(slack).toContain(run.alerts[0]!.title);
    const md = recommendationsToMarkdown(run.recommendations);
    expect(md.split("\n")).toHaveLength(run.recommendations.length + 2);
    expect(recommendationsToMarkdown([])).toMatch(/No recommendations/);
    expect(describeRec(run.recommendations.find((r) => r.rule === "scale-winner")!)).toContain("120 -> 144");
  });

  it("daily brief prompt lists each finding and totals", () => {
    const prompt = dailyBriefTask.prompt({ asOf, clientName: "X", totals: { spend: 1, revenue: 2, roas: 2, conversions: 3, cpa: 4 }, recommendations: [{ id: "r", title: "T", rationale: "R", risk: "human", type: "pause_ad" }] });
    expect(prompt).toContain("[r] (human) T: R");
    expect(prompt).toContain("ROAS 2");
  });

  it("buildWindows computes windows per ad set with client targets", () => {
    const windows = buildWindows(data, asOf, config);
    expect(windows).toHaveLength(data.adsets.length);
    const hearth = windows.find((w) => w.adsetId === "hearthline-c1-as1")!;
    expect(hearth.targetRoas).toBe(3);
    expect(hearth.recent.spend).toBeGreaterThan(0);
    expect(hearth.ads).toHaveLength(2);
    expect(hearth.recent3.spend).toBeLessThan(hearth.recent.spend);
  });
});

import { describe, expect, it } from "vitest";
import type { AdsDataset } from "../../src/core/ads";
import { MockMetaAdsClient, RulesConfigSchema, buildWindows, evaluateRules, runMediaBuyerAgent, type MetaAdsClient } from "../../src/areas/media-buyer";
import { generateMockDataset } from "../../src/areas/toast";
import { provider } from "../helpers";

/**
 * Scenario group E: the agent moves money. Its inputs come from a nightly
 * Meta sync that can duplicate rows, arrive late, or contain zeros; its
 * configuration comes from humans who type things.
 */
const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const config = RulesConfigSchema.parse({});

describe("E1 · data quality from the Meta sync", () => {
  it("duplicate daily rows (a re-synced day) do not double count spend or conversions", () => {
    const dup: AdsDataset = { ...data, metrics: [...data.metrics, ...data.metrics.filter((m) => m.date === asOf)] };
    const clean = buildWindows(data, asOf, config).find((w) => w.adsetId === "hearthline-c1-as1")!;
    const dirty = buildWindows(dup, asOf, config).find((w) => w.adsetId === "hearthline-c1-as1")!;
    expect(dirty.recent.spend).toBeCloseTo(clean.recent.spend, 2);
    expect(dirty.recent.conversions).toBe(clean.recent.conversions);
  });

  it("rows dated after asOf (clock skew, timezone) are ignored", () => {
    const future = data.metrics.filter((m) => m.date === asOf).map((m) => ({ ...m, date: "2026-11-09", spend: 999999 }));
    const w = buildWindows({ ...data, metrics: [...data.metrics, ...future] }, asOf, config).find((x) => x.adsetId === "hearthline-c1-as1")!;
    expect(w.recent.spend).toBeLessThan(10_000);
  });

  it("an ad set with no rows at all produces no recommendations and no NaN", () => {
    const empty: AdsDataset = { ...data, metrics: [] };
    const windows = buildWindows(empty, asOf, config);
    for (const w of windows) {
      expect(Number.isNaN(w.recent.roas)).toBe(false);
      expect(Number.isNaN(w.recent.cpa)).toBe(false);
    }
    // learning-limited is driven by Meta's reported status, so it may fire without metrics; nothing metric-based should.
    expect(evaluateRules(windows, config, asOf).filter((r) => r.rule !== "learning-limited")).toEqual([]);
  });

  it("asOf before the dataset starts yields an empty, non-crashing run", async () => {
    const run = await runMediaBuyerAgent({ data, asOf: "2020-01-01", provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "autopilot" });
    expect(run.recommendations.filter((r) => r.rule !== "learning-limited")).toEqual([]);
    expect(run.actions).toEqual([]);
    expect(run.briefs).toHaveLength(data.clients.length);
  });

  it("a paused ad set never receives budget changes even if its history looks like a winner", () => {
    const paused: AdsDataset = { ...data, adsets: data.adsets.map((a) => (a.id === "hearthline-c1-as1" ? { ...a, status: "PAUSED" as const } : a)) };
    const recs = evaluateRules(buildWindows(paused, asOf, config), config, asOf);
    expect(recs.filter((r) => r.entity.id === "hearthline-c1-as1" || r.entity.id.startsWith("hearthline-c1-as1-"))).toEqual([]);
  });
});

describe("E2 · configuration humans type", () => {
  it("rejects nonsense thresholds", () => {
    expect(() => RulesConfigSchema.parse({ budgetStepPct: -20 })).toThrow();
    expect(() => RulesConfigSchema.parse({ lookbackDays: 0 })).toThrow();
    expect(() => RulesConfigSchema.parse({ maxDailyBudgetGbp: "lots" })).toThrow();
  });

  it("a budget step that rounds to no change is not proposed", () => {
    const tiny: AdsDataset = { ...data, adsets: data.adsets.map((a) => (a.id === "kindred-c1-as1" ? { ...a, dailyBudgetGbp: 1 } : a)) };
    const recs = evaluateRules(buildWindows(tiny, asOf, config), config, asOf).filter((r) => r.entity.id === "kindred-c1-as1" && r.proposedChange?.field === "daily_budget_gbp");
    for (const r of recs) expect(r.proposedChange!.from, r.rule).not.toBe(r.proposedChange!.to);
  });

  it("a client with a target CPA of zero does not flag every ad as dead", () => {
    const zero: AdsDataset = { ...data, clients: data.clients.map((c) => (c.id === "hearthline" ? { ...c, targetCpaGbp: 0 } : c)) };
    const recs = evaluateRules(buildWindows(zero, asOf, config), config, asOf);
    expect(recs.filter((r) => r.rule === "zero-conversion-ad" && r.entity.clientId === "hearthline")).toHaveLength(0);
  });

  it("an unknown autonomy level is rejected rather than silently treated as assist", async () => {
    await expect(runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "yolo" as never })).rejects.toThrow(/autonomy/);
  });

  it("an approved id that does not exist in today's run is ignored and reported, not executed", async () => {
    const client = new MockMetaAdsClient();
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "assist", dryRun: false, approvedIds: ["scale-winner:does-not-exist:2026-11-08"] });
    expect(client.calls).toEqual([]);
    expect(run.actions).toEqual([]);
  });

  it("an approval from a previous day does not execute today's regenerated recommendation", async () => {
    const client = new MockMetaAdsClient();
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "assist", dryRun: false, approvedIds: ["scale-winner:hearthline-c1-as1:2026-11-07"] });
    expect(run.recommendations.find((r) => r.rule === "scale-winner")?.status).toBe("proposed");
    expect(client.calls).toEqual([]);
  });
});

describe("E3 · the ads API misbehaves", () => {
  it("a client that throws (network error) marks the recommendation failed and continues with the rest", async () => {
    const flaky: MetaAdsClient = {
      name: "flaky",
      updateAdsetBudget: async () => {
        throw new Error("ECONNRESET");
      },
      pauseAd: async () => ({ ok: true, detail: "paused" }),
      pauseAdset: async () => ({ ok: true, detail: "paused" }),
    };
    const run = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: flaky, autonomy: "autopilot", dryRun: false });
    const budgetRecs = run.recommendations.filter((r) => r.proposedChange?.field === "daily_budget_gbp" && r.risk === "approve");
    expect(budgetRecs.length).toBeGreaterThan(0);
    for (const r of budgetRecs) expect(r.status).toBe("failed");
    expect(run.actions.filter((a) => !a.ok).every((a) => /ECONNRESET/.test(a.detail))).toBe(true);
    expect(run.recommendations.find((r) => r.rule === "zero-conversion-ad")?.status).toBe("auto_executed");
  });

  it("a client that hangs is bounded by a timeout rather than blocking the daily run forever", async () => {
    const hanging: MetaAdsClient = {
      name: "hanging",
      updateAdsetBudget: () => new Promise(() => {}),
      pauseAd: async () => ({ ok: true, detail: "ok" }),
      pauseAdset: async () => ({ ok: true, detail: "ok" }),
    };
    const result = await Promise.race([
      runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: hanging, autonomy: "autopilot", dryRun: false }).then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 3000)),
    ]);
    expect(result).toBe("finished");
  }, 10_000);

  it("running the agent twice on the same day produces identical recommendation ids and no duplicate actions", async () => {
    const client = new MockMetaAdsClient();
    const a = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "autopilot", dryRun: false });
    const b = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: client, autonomy: "autopilot", dryRun: false });
    expect(a.recommendations.map((r) => r.id)).toEqual(b.recommendations.map((r) => r.id));
    expect(client.calls.length).toBe(a.actions.filter((x) => x.ok).length);
  });
});

describe("E4 · untrusted text from the ad account", () => {
  it("entity names containing Slack markup or HTML do not break alerts or the dashboard", async () => {
    const hostile: AdsDataset = { ...data, adsets: data.adsets.map((a) => (a.id === "bluewater-c1-as1" ? { ...a, name: "OC <script>alert(1)</script> *bold* _it_ <!channel>" } : a)) };
    const run = await runMediaBuyerAgent({ data: hostile, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist" });
    const alert = run.alerts.find((a) => a.entityIds.includes("bluewater-c1-as1"))!;
    expect(alert).toBeTruthy();
    const { formatSlackAlert } = await import("../../src/areas/media-buyer");
    const slack = formatSlackAlert(alert);
    expect(slack).not.toContain("<!channel>");
  });
});

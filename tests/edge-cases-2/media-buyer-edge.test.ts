/**
 * Second production-breakage pass · media buyer rules, agent, launch payloads, Meta execution.
 */
import { describe, expect, it } from "vitest";
import type { AdsDataset, AdMetricsDaily } from "../../src/core/ads";
import { MockProvider } from "../../src/core/llm";
import { buildWindows, evaluateRules, RulesConfigSchema, runMediaBuyerAgent, MockMetaAdsClient, recommendationsToMarkdown, formatSlackAlert, decideExecution, buildMetaLaunchBundle, parseAgeRange, type Recommendation } from "../../src/areas/media-buyer";
import { buildLaunchPlan } from "../../src/orchestrator/pipeline";
import { generateMockDataset } from "../../src/areas/toast";
import { addDays } from "../../src/core/ads";
import { sampleBrief, sampleCopy } from "../helpers";

const AS_OF = "2026-11-08";
const provider = new MockProvider();

/** One client, one ad set, two ads, with a day-by-day generator so each scenario is explicit. */
function dataset(rows: (date: string, dayIndex: number) => Array<Partial<AdMetricsDaily> & { adId: string }>, adsetStatus: "ACTIVE" | "PAUSED" = "ACTIVE", days = 14): AdsDataset {
  const metrics: AdMetricsDaily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(AS_OF, -i);
    for (const r of rows(date, days - 1 - i)) {
      metrics.push({ date, clientId: "c1", campaignId: "cp1", adsetId: "as1", spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, revenue: 0, ...r });
    }
  }
  return {
    clients: [{ id: "c1", name: "Client One", adAccountId: "act_1", targetRoas: 3, targetCpaGbp: 20 }],
    campaigns: [{ id: "cp1", clientId: "c1", name: "Campaign", objective: "donations", status: "ACTIVE" }],
    adsets: [{ id: "as1", campaignId: "cp1", clientId: "c1", name: "Ad set | one", dailyBudgetGbp: 100, status: adsetStatus, learningStatus: "active" }],
    ads: [
      { id: "ad1", adsetId: "as1", campaignId: "cp1", clientId: "c1", name: "Ad one", creativeType: "static", status: "ACTIVE", launchedOn: addDays(AS_OF, -60) },
      { id: "ad2", adsetId: "as1", campaignId: "cp1", clientId: "c1", name: "Ad two", creativeType: "video", status: "ACTIVE", launchedOn: addDays(AS_OF, -60) },
    ],
    metrics,
    range: { start: addDays(AS_OF, -(days - 1)), end: AS_OF },
  };
}
const config = RulesConfigSchema.parse({});
const recsFor = (data: AdsDataset, cfg = config) => evaluateRules(buildWindows(data, AS_OF, cfg), cfg, AS_OF);

describe("M1 · rules that contradict each other or act on the wrong entity", () => {
  it.fails("[BUG2-31] an ad set that is both far below ROAS floor and spiking in CPA gets one coherent action, not pause and trim together", () => {
    // Previous week: healthy. This week: same spend, CPA doubled, revenue collapsed.
    const data = dataset((_d, i) => (i < 7 ? [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }] : [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 2, revenue: 40 }]));
    const recs = recsFor(data);
    const types = recs.filter((r) => r.entity.id === "as1").map((r) => r.type);
    expect(types).toContain("pause_adset");
    expect(types).not.toContain("decrease_budget");
  });

  it.fails("[BUG2-32] ads inside a PAUSED ad set are not flagged for creative fatigue", () => {
    const data = dataset((_d, i) => (i < 7 ? [{ adId: "ad1", spend: 60, impressions: 8000, reach: 2000, clicks: 240, linkClicks: 200, conversions: 4, revenue: 200 }] : [{ adId: "ad1", spend: 60, impressions: 8000, reach: 1500, clicks: 80, linkClicks: 60, conversions: 3, revenue: 150 }]), "PAUSED");
    expect(recsFor(data).map((r) => r.rule)).not.toContain("creative-fatigue");
  });

  it.fails("[BUG2-33] a budget step percentage of 100 or more is rejected by the config schema", () => {
    expect(RulesConfigSchema.safeParse({ budgetStepPct: 150 }).success).toBe(false);
    expect(RulesConfigSchema.safeParse({ budgetStepPct: 100 }).success).toBe(false);
    expect(RulesConfigSchema.safeParse({ budgetStepPct: 99 }).success).toBe(true);
  });

  it("no rule ever proposes a daily budget below £1 or above the configured maximum", () => {
    const data = dataset((_d, i) => (i < 7 ? [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }] : [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 2, revenue: 100 }]));
    data.adsets[0]!.dailyBudgetGbp = 1.2;
    for (const r of recsFor(data)) {
      if (r.proposedChange?.field !== "daily_budget_gbp") continue;
      expect(Number(r.proposedChange.to)).toBeGreaterThanOrEqual(1);
      expect(Number(r.proposedChange.to)).toBeLessThanOrEqual(config.maxDailyBudgetGbp);
    }
  });

  it.fails("[BUG2-34] a client with zero delivery in the window gets a brief that says nothing ran, not 'steady, no action needed'", async () => {
    const data = dataset(() => []);
    const run = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
    expect(run.briefs[0]!.brief.headline.toLowerCase()).not.toMatch(/steady|no action needed/);
    expect(`${run.briefs[0]!.brief.headline} ${run.briefs[0]!.brief.summary}`.toLowerCase()).toMatch(/no (advertising|delivery|spend)|did not run|nothing ran|paused/);
  });
});

describe("M2 · names from the ad account inside tables and messages", () => {
  const rec: Recommendation = {
    id: "r1",
    rule: "cpa-spike",
    type: "decrease_budget",
    entity: { level: "adset", id: "as1", name: "Lookalike | 1% | Donors\nQ4", clientId: "c1" },
    title: "CPA up | 40%",
    rationale: "x",
    evidence: {},
    risk: "approve",
    confidence: 0.7,
    proposedChange: { field: "daily_budget_gbp", from: 100, to: 80 },
    status: "proposed",
    createdOn: AS_OF,
  };

  it.fails("[BUG2-35] pipes and newlines in entity names do not break the markdown table", () => {
    const md = recommendationsToMarkdown([rec]);
    const dataRows = md.split("\n").slice(2);
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]!.split("|").length).toBe(8); // 6 cells + leading/trailing
  });

  it("Slack alerts neutralise mrkdwn and mention syntax from names", () => {
    const text = formatSlackAlert({ id: "a", severity: "warning", title: "<!channel> *urgent* <https://evil.example|click>", message: "_m_", entityIds: ["<@U123>"], clientId: "c1", channel: "slack" });
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
    expect(text).not.toMatch(/<https:/);
  });
});

describe("M3 · execution policy", () => {
  const base: Recommendation = { id: "r", rule: "scale-winner", type: "increase_budget", entity: { level: "adset", id: "as1", name: "x", clientId: "c1" }, title: "t", rationale: "r", evidence: {}, risk: "approve", confidence: 0.7, proposedChange: { field: "daily_budget_gbp", from: 100, to: 120 }, status: "proposed", createdOn: AS_OF };

  it("autopilot never auto-executes a change whose 'from' is missing or zero", () => {
    expect(decideExecution({ ...base, proposedChange: { field: "daily_budget_gbp", from: 0, to: 120 } }, "autopilot", new Set(), config)).toBe("skip");
    expect(decideExecution({ ...base, proposedChange: { field: "daily_budget_gbp", from: "", to: 120 } }, "autopilot", new Set(), config)).toBe("skip");
  });

  it("an approved human-tier recommendation executes even in assist mode, but an approved id never executes a different recommendation", async () => {
    const data = dataset((_d, i) => (i < 7 ? [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }] : [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 2, revenue: 40 }]));
    const client = new MockMetaAdsClient();
    const first = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: client, autonomy: "assist" });
    const human = first.recommendations.find((r) => r.risk === "human" && r.proposedChange);
    expect(human).toBeDefined();
    const second = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: client, autonomy: "assist", approvedIds: [human!.id, "stale:other:2026-01-01"] });
    expect(second.actions.map((a) => a.recommendationId)).toEqual([human!.id]);
    expect(client.calls).toHaveLength(1);
  });

  it("a live run against an ads client that rejects every call never leaves a recommendation marked executed", async () => {
    const data = dataset((_d, i) => (i < 7 ? [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }, { adId: "ad2", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }] : [{ adId: "ad1", spend: 60, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 6, revenue: 400 }, { adId: "ad2", spend: 70, impressions: 6000, reach: 5000, clicks: 120, linkClicks: 100, conversions: 0, revenue: 0 }]));
    const client = new MockMetaAdsClient(new Set(["ad2", "as1"]));
    const run = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: client, autonomy: "autopilot" });
    for (const r of run.recommendations) expect(r.status).not.toMatch(/executed/);
    for (const a of run.actions) expect(a.ok).toBe(false);
  });
});

describe("M4 · Meta launch payloads", () => {
  const brief = sampleBrief();
  const copy = sampleCopy(brief);
  const options = { adAccountId: "act_123", pageId: "p", pixelId: "px", landingBaseUrl: "https://give.example.org/" };

  it.fails("[BUG2-36] age ranges written as '65+', '35–55' (en dash) or '35 to 55' are honoured, not silently widened to 18-65", () => {
    expect(parseAgeRange("65+")).toEqual([65, 65]);
    expect(parseAgeRange("35–55")).toEqual([35, 55]);
    expect(parseAgeRange("35 to 55")).toEqual([35, 55]);
    expect(parseAgeRange("18-24")).toEqual([18, 24]);
  });

  it.fails("[BUG2-37] a daily budget that splits below Meta's minimum per ad set is flagged in the bundle", () => {
    const b = { ...brief, constraints: { ...brief.constraints, dailyBudgetGbp: 3 } };
    const plan = buildLaunchPlan(b, "idea-1", copy, ["creative-idea-1-square"]);
    const bundle = buildMetaLaunchBundle(plan, b, copy, options);
    expect(bundle.adsets.every((a) => a.daily_budget >= 100) || (bundle.summary as { warnings?: string[] }).warnings?.some((w) => /minimum/i.test(w))).toBe(true);
  });

  it("the ad set budgets add up to the campaign daily budget within rounding", () => {
    const plan = buildLaunchPlan(brief, "idea-1", copy, ["creative-idea-1-square", "creative-idea-1-story"]);
    const bundle = buildMetaLaunchBundle(plan, brief, copy, options);
    const daily = (brief.constraints.dailyBudgetGbp ?? 100) * 100;
    expect(Math.abs(bundle.summary.dailyBudgetPence - daily)).toBeLessThanOrEqual(bundle.adsets.length);
  });

  it("campaign names with ampersands and quotes produce valid UTM tags and landing links", () => {
    const b = { ...brief, campaignName: `Warm & Well "2026" <winter>` };
    const plan = buildLaunchPlan(b, "idea-1", copy, ["creative-idea-1-square"]);
    const bundle = buildMetaLaunchBundle(plan, b, copy, options);
    for (const c of bundle.creatives) {
      expect(c.url_tags).not.toMatch(/[&"<>]{2}|utm_campaign=[^&]*[ "<>]/);
      expect(c.object_story_spec.link_data.link).toMatch(/^https:\/\/give\.example\.org\/[a-z0-9-]+-(a|b)$/);
    }
  });

  it.fails("[BUG2-38] an end date before the start date never reaches the ad set payload", () => {
    const b = { ...brief, constraints: { ...brief.constraints, startDate: "2026-12-01", endDate: "2026-11-01" } };
    const plan = buildLaunchPlan(b, "idea-1", copy, ["creative-idea-1-square"]);
    expect(() => buildMetaLaunchBundle(plan, b, copy, options)).toThrow(/end/i);
  });

  it("every ad references an ad set and a creative that exist in the bundle", () => {
    const plan = buildLaunchPlan(brief, "idea-1", copy, ["creative-idea-1-square", "creative-idea-1-story"]);
    const bundle = buildMetaLaunchBundle(plan, brief, copy, options);
    const adsetRefs = new Set(bundle.adsets.map((a) => `adset:${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)}`));
    const creativeRefs = new Set(bundle.creatives.map((c) => c.creative_ref));
    for (const ad of bundle.ads) {
      expect(adsetRefs.has(ad.adset_ref), ad.adset_ref).toBe(true);
      expect(creativeRefs.has(ad.creative_ref)).toBe(true);
    }
  });
});

describe("M5 · the demo dataset under unusual dates", () => {
  it("asOf on the first day of the dataset still runs end to end", async () => {
    const data = generateMockDataset({ asOf: AS_OF, days: 56 });
    const run = await runMediaBuyerAgent({ data, asOf: data.range.start, provider, adsClient: new MockMetaAdsClient(), autonomy: "copilot", dryRun: true });
    expect(run.briefs.length).toBe(data.clients.length);
  });

  it("asOf after the dataset ends treats the gap as zero delivery without inventing changes", async () => {
    const data = generateMockDataset({ asOf: AS_OF, days: 56 });
    const run = await runMediaBuyerAgent({ data, asOf: addDays(AS_OF, 30), provider, adsClient: new MockMetaAdsClient(), autonomy: "autopilot" });
    expect(run.actions).toEqual([]);
  });
});

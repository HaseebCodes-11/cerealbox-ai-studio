import { describe, expect, it } from "vitest";
import { AdMetricsDailySchema } from "../../src/core/ads";
import {
  CLIENT_PROFILES,
  aggregate,
  answerIntent,
  askToast,
  comparePeriods,
  dailySeries,
  detectAnomalies,
  generateInsights,
  generateMockDataset,
  insightsToMarkdown,
  intentTask,
  lastNDays,
  narrativeTask,
  pacing,
  parseIntentHeuristically,
  pctChange,
  previousPeriod,
  renderDashboard,
  topMovers,
  totals,
} from "../../src/areas/toast";
import { provider } from "../helpers";

const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const names = data.clients.map((c) => c.name);

describe("mock dataset", () => {
  it("is deterministic and covers the requested range", () => {
    const again = generateMockDataset({ asOf });
    expect(JSON.stringify(again.metrics.slice(0, 50))).toBe(JSON.stringify(data.metrics.slice(0, 50)));
    expect(data.range).toEqual({ start: "2026-09-14", end: asOf });
    expect(data.metrics.every((m) => m.date >= data.range.start && m.date <= data.range.end)).toBe(true);
    expect(generateMockDataset({ asOf, seed: "other" }).metrics[0]!.spend).not.toBe(data.metrics[0]!.spend);
  });

  it("has consistent entities and schema-valid rows", () => {
    expect(data.clients).toHaveLength(CLIENT_PROFILES.length);
    const adsetIds = new Set(data.adsets.map((a) => a.id));
    const adIds = new Set(data.ads.map((a) => a.id));
    for (const row of data.metrics) {
      expect(adsetIds.has(row.adsetId)).toBe(true);
      expect(adIds.has(row.adId)).toBe(true);
      expect(AdMetricsDailySchema.safeParse(row).success).toBe(true);
      expect(row.linkClicks).toBeLessThanOrEqual(row.clicks);
      expect(row.reach).toBeLessThanOrEqual(row.impressions);
    }
    expect(data.adsets.find((a) => a.id === "brightstart-c1-as1")?.learningStatus).toBe("learning_limited");
  });

  it("does not report metrics for ads before their launch date", () => {
    const puppy = data.ads.find((a) => a.id === "paws-c1-as1-ad2")!;
    expect(data.metrics.filter((m) => m.adId === puppy.id).every((m) => m.date >= puppy.launchedOn)).toBe(true);
    expect(data.metrics.filter((m) => m.adId === puppy.id && m.conversions > 0)).toHaveLength(0);
  });
});

describe("aggregation", () => {
  const period = lastNDays(asOf, 7);

  it("period helpers compute inclusive windows", () => {
    expect(period).toEqual({ start: "2026-11-02", end: asOf });
    expect(previousPeriod(period)).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });

  it("client totals add up to the portfolio total", () => {
    const clients = aggregate(data, "client", period);
    const portfolio = totals(data, period);
    expect(clients.reduce((s, c) => s + c.spend, 0)).toBeCloseTo(portfolio.spend, 1);
    expect(clients.reduce((s, c) => s + c.conversions, 0)).toBe(portfolio.conversions);
    expect(clients[0]!.spend).toBeGreaterThanOrEqual(clients[clients.length - 1]!.spend);
    expect(clients.every((c) => c.clientName === names.find((n) => n === c.name))).toBe(true);
  });

  it("groups by every dimension and filters by client", () => {
    expect(aggregate(data, "campaign", period).length).toBe(data.campaigns.length);
    expect(aggregate(data, "adset", period).length).toBe(data.adsets.length);
    expect(aggregate(data, "ad", period).length).toBe(data.ads.filter((a) => a.launchedOn <= asOf).length);
    const types = aggregate(data, "creativeType", period).map((t) => t.name).sort();
    expect(types).toEqual(["carousel", "static", "ugc", "video"]);
    expect(aggregate(data, "adset", period, { clientId: "hearthline" }).every((r) => r.clientId === "hearthline")).toBe(true);
  });

  it("compares periods with percentage deltas and finds movers", () => {
    const cmp = comparePeriods(data, "client", asOf, 7);
    expect(cmp).toHaveLength(data.clients.length);
    const hearth = cmp.find((c) => c.clientId === "hearthline")!;
    expect(hearth.deltas.spend).toBeCloseTo(pctChange(hearth.recent.spend, hearth.previous.spend), 6);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(5, 0)).toBe(100);
    expect(pctChange(50, 100)).toBe(-50);
    const movers = topMovers(cmp, "roas", "down", 2);
    expect(movers).toHaveLength(2);
    expect(movers[0]!.deltas.roas).toBeLessThanOrEqual(movers[1]!.deltas.roas);
    expect(topMovers(cmp, "roas", "down", 5, 1_000_000)).toEqual([]);
  });

  it("daily series has one point per day, including zero days", () => {
    const series = dailySeries(data, "spend", lastNDays(asOf, 28));
    expect(series).toHaveLength(28);
    expect(series[0]!.date).toBe("2026-10-12");
    const empty = dailySeries(data, "spend", { start: "2020-01-01", end: "2020-01-03" });
    expect(empty.map((p) => p.value)).toEqual([0, 0, 0]);
  });

  it("detects anomalies with a rolling z-score", () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, value: 100 }));
    expect(detectAnomalies(flat)).toEqual([]);
    const spike = flat.map((p, i) => (i === 25 ? { ...p, value: 500 } : p));
    const found = detectAnomalies(spike);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ date: "d25", value: 500, direction: "high" });
    const noisy = flat.map((p, i) => ({ ...p, value: 100 + (i % 2 ? 5 : -5) }));
    const dip = noisy.map((p, i) => (i === 20 ? { ...p, value: 40 } : p));
    expect(detectAnomalies(dip)[0]).toMatchObject({ date: "d20", direction: "low" });
  });

  it("computes spend pacing against ad set budgets", () => {
    const p = pacing(data, period, "brightstart");
    expect(p.budgeted).toBe(35 * 7);
    expect(p.pacePct).toBeLessThan(80);
    const h = pacing(data, period, "hearthline");
    expect(h.pacePct).toBeGreaterThan(80);
    expect(h.pacePct).toBeLessThan(110);
  });
});

describe("insights and narrative", () => {
  const insights = generateInsights(data, asOf);

  it("surfaces the tracking break as critical and sorts by severity", () => {
    expect(insights[0]!.severity).toBe("critical");
    expect(insights[0]!.title).toContain("OC - Interests Marine");
    const order = { critical: 0, warning: 1, positive: 2, info: 3 };
    for (let i = 1; i < insights.length; i++) expect(order[insights[i - 1]!.severity]).toBeLessThanOrEqual(order[insights[i]!.severity]);
    expect(insights.some((i) => i.id === "portfolio-summary")).toBe(true);
    expect(insights.some((i) => i.id === "client-roas-beat:hearthline")).toBe(true);
    expect(insights.some((i) => i.id === "client-roas-miss:northlight")).toBe(true);
    expect(insights.some((i) => i.id === "creative-type-comparison")).toBe(true);
    expect(insights.some((i) => i.id === "client-pacing:brightstart")).toBe(true);
  });

  it("narrative uses only the insight figures", async () => {
    const r = await provider().run(narrativeTask, { asOf, days: 7, insights });
    expect(r.output.headline).toMatch(/urgent/);
    expect(r.output.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(r.output.paragraphs[1]).toMatch(/Urgent/);
    expect(r.output.actionsToday.length).toBeGreaterThan(0);
    expect(narrativeTask.prompt({ asOf, days: 7, insights })).toContain("[critical]");
    const md = insightsToMarkdown(insights);
    expect(md.split("\n").filter((l) => l.startsWith("- ")).length).toBe(insights.length);
  });
});

describe("Ask Toast", () => {
  it("parses intents heuristically", () => {
    expect(parseIntentHeuristically("Which client had the biggest ROAS drop last week?", names)).toMatchObject({ intent: "biggest_change", metric: "roas", direction: "down", days: 7 });
    expect(parseIntentHeuristically("How much did we spend last month?", names)).toMatchObject({ intent: "portfolio_total", metric: "spend", days: 28 });
    expect(parseIntentHeuristically("How is Hearthline doing over the last 14 days?", names)).toMatchObject({ intent: "client_summary", clientName: "Hearthline", days: 14 });
    expect(parseIntentHeuristically("Do video or static creatives perform better?", names)).toMatchObject({ intent: "creative_type_comparison" });
    expect(parseIntentHeuristically("Anything unusual this week?", names)).toMatchObject({ intent: "anomalies" });
    expect(parseIntentHeuristically("Which clients have the worst CPA?", names)).toMatchObject({ intent: "rank_clients", metric: "cpa", direction: "down" });
    expect(parseIntentHeuristically("Show the top 3 clients by revenue", names)).toMatchObject({ intent: "rank_clients", metric: "revenue", limit: 3, direction: "up" });
    expect(parseIntentHeuristically("What is the weather", names).intent).toBe("unknown");
  });

  it("answers every intent with real numbers from the aggregation layer", () => {
    const period = lastNDays(asOf, 7);
    const total = answerIntent("q", { intent: "portfolio_total", metric: "spend", direction: "down", days: 7, limit: 5 }, data, asOf);
    expect(total.text).toContain(`£${Math.round(totals(data, period).spend).toLocaleString("en-GB")}`);
    expect(total.table?.rows[0]).toHaveLength(6);

    const rank = answerIntent("q", { intent: "rank_clients", metric: "cpa", direction: "down", days: 7, limit: 3 }, data, asOf);
    expect(rank.table?.rows).toHaveLength(3);
    const cpas = rank.table!.rows.map((r) => Number(r[1]));
    expect(cpas[0]).toBeGreaterThanOrEqual(cpas[1]!);

    const change = answerIntent("q", { intent: "biggest_change", metric: "roas", direction: "down", days: 7, limit: 3 }, data, asOf);
    expect(change.text).toMatch(/deterioration/);
    expect(change.chart?.values[0]).toBeLessThanOrEqual(change.chart!.values[1]!);

    const client = answerIntent("q", { intent: "client_summary", metric: "roas", clientName: "Hearthline", direction: "down", days: 7, limit: 5 }, data, asOf);
    expect(client.text).toContain("Hearthline");
    expect(client.text).toMatch(/on or above/);
    expect(client.chart?.labels).toHaveLength(7);

    const unknownClient = answerIntent("q", { intent: "client_summary", metric: "roas", clientName: "Nobody", direction: "down", days: 7, limit: 5 }, data, asOf);
    expect(unknownClient.text).toMatch(/could not match/);

    const types = answerIntent("q", { intent: "creative_type_comparison", metric: "roas", direction: "up", days: 7, limit: 5 }, data, asOf);
    expect(types.table?.rows).toHaveLength(4);
    expect(types.text).toMatch(/ugc leads on ROAS/);

    const anomalies = answerIntent("q", { intent: "anomalies", metric: "roas", direction: "down", days: 7, limit: 5 }, data, asOf);
    expect(anomalies.text).toContain("OC - Interests Marine");

    const unknown = answerIntent("q", { intent: "unknown", metric: "roas", direction: "down", days: 7, limit: 5 }, data, asOf);
    expect(unknown.text).toMatch(/I can answer/);
  });

  it("goes end to end through the provider", async () => {
    const a = await askToast("Which client had the biggest CPA increase?", data, asOf, provider());
    expect(a.intent.intent).toBe("biggest_change");
    expect(a.intent.metric).toBe("cpa");
    expect(a.text).toMatch(/CPA/);
    expect(intentTask.prompt({ question: "x", clientNames: names })).toContain("Hearthline");
  });
});

describe("dashboard", () => {
  it("renders a complete, escaped HTML page with data and no undefined/NaN", async () => {
    const insights = generateInsights(data, asOf);
    const narrative = (await provider().run(narrativeTask, { asOf, days: 7, insights })).output;
    const answers = [await askToast("How is Hearthline doing?", data, asOf, provider())];
    const html = renderDashboard({ data, asOf, insights, narrative, sampleAnswers: answers, recommendations: [] });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Toast");
    for (const label of ["Spend", "Revenue (donations)", "ROAS", "Donations", "CPA", "Avg gift"]) expect(html).toContain(label);
    for (const name of names) expect(html).toContain(name);
    expect(html).toContain('id="toast-data"');
    const json = JSON.parse(html.split('<script id="toast-data" type="application/json">')[1]!.split("</script>")[0]!);
    expect(json.labels).toHaveLength(28);
    expect(json.clientLabels).toHaveLength(data.clients.length);
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).not.toMatch(/undefined|NaN/);
    expect(html).toContain("How is Hearthline doing?");
    expect(html).not.toContain("Media Buyer agent · recommendations");
    expect(html).not.toContain("integrity=");
  });

  it("includes the agent table when recommendations are passed", async () => {
    const insights = generateInsights(data, asOf);
    const narrative = (await provider().run(narrativeTask, { asOf, days: 7, insights })).output;
    const rec = { id: "r", rule: "scale-winner", type: "increase_budget" as const, entity: { level: "adset" as const, id: "hearthline-c1-as1", name: "WW <b>Lookalike</b>", clientId: "hearthline" }, title: "Scale it", rationale: "because", evidence: {}, risk: "approve" as const, confidence: 0.75, proposedChange: { field: "daily_budget_gbp" as const, from: 120, to: 144 }, status: "proposed" as const, createdOn: asOf };
    const html = renderDashboard({ data, asOf, insights, narrative, recommendations: [rec] });
    expect(html).toContain("Media Buyer agent · recommendations");
    expect(html).toContain("120 → 144");
    expect(html).toContain("WW &lt;b&gt;Lookalike&lt;/b&gt;");
  });
});

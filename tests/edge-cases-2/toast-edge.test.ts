/**
 * Second production-breakage pass · Toast metrics, Ask Toast, insights, dashboard.
 */
import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/core/llm";
import { addDays } from "../../src/core/ads";
import { answerIntent, askToast, parseIntentHeuristically, generateInsights, generateMockDataset, narrativeTask, renderDashboard } from "../../src/areas/toast";
import { comparePeriods, detectAnomalies, lastNDays, pctChange, totals, dailySeries } from "../../src/areas/toast/metrics";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../../src/areas/media-buyer";

const AS_OF = "2026-11-08";
const data = generateMockDataset({ asOf: AS_OF });
const provider = new MockProvider();
const names = data.clients.map((c) => c.name);

describe("N1 · metric windows nobody intended", () => {
  it("a zero or negative day count yields empty totals, not a crash or a window reaching into the future", () => {
    for (const days of [0, -3]) {
      const period = lastNDays(AS_OF, days);
      const t = totals(data, period);
      expect(t.spend).toBe(0);
      expect(Number.isFinite(t.roas)).toBe(true);
    }
  });

  it("pctChange never returns NaN or Infinity", () => {
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(5, 0)).toBe(100);
    expect(pctChange(0, 5)).toBe(-100);
    expect(Number.isFinite(pctChange(1e-9, 1e-12))).toBe(true);
  });

  it("anomaly detection on a series shorter than its window finds nothing rather than indexing off the end", () => {
    const series = dailySeries(data, "revenue", lastNDays(AS_OF, 5));
    expect(detectAnomalies(series, { window: 14 })).toEqual([]);
  });

  it("a comparison window that starts before the dataset reports hasBaseline=false for every client", () => {
    for (const c of comparePeriods(data, "client", data.range.start, 7)) expect(c.hasBaseline).toBe(false);
  });
});

describe("N2 · questions with real client names", () => {
  it.fails("[BUG2-39] 'and' in a question matches a client whose name uses an ampersand", () => {
    expect(names).toContain("Paws & Place");
    const intent = parseIntentHeuristically("How is Paws and Place doing this week?", names);
    expect(intent.intent).toBe("client_summary");
    expect(intent.clientName).toBe("Paws & Place");
  });

  it.fails("[BUG2-40] a client whose name is a prefix of another is not treated as two clients", () => {
    const clients = ["Bright Start", "Bright Start Trust"];
    const intent = parseIntentHeuristically("How is Bright Start Trust doing?", clients);
    expect(intent.intent).toBe("client_summary");
    expect(intent.clientName).toBe("Bright Start Trust");
  });

  it.fails("[BUG2-41] a ranking over a window with no spend says so instead of ending with an empty list", () => {
    const answer = answerIntent("Which clients have the worst ROAS?", { intent: "rank_clients", metric: "roas", direction: "down", days: 7, limit: 5 }, data, addDays(data.range.start, -30));
    expect(answer.text).not.toMatch(/:\s*\.$/);
    expect(answer.text.toLowerCase()).toMatch(/no (spend|delivery|data)/);
  });

  it("a client summary for a client with no ad sets in the window still reads as a sentence", async () => {
    const answer = await askToast("How is Hearthline doing?", data, addDays(data.range.start, -30), provider);
    expect(answer.text).not.toMatch(/undefined|NaN|Infinity/);
  });

  it.fails("[BUG2-42] 'biggest spend increase' asks for the up direction on spend, not a ROAS drop", () => {
    const intent = parseIntentHeuristically("Who had the biggest spend increase?", names);
    expect(intent.metric).toBe("spend");
    expect(intent.direction).toBe("up");
    expect(intent.intent).toBe("biggest_change");
  });
});

describe("N3 · Toast and the agent agree about tracking breaks", () => {
  it("every ad set Toast calls a tracking break is also what the agent raises, on every day of the last week", async () => {
    for (let i = 0; i < 7; i++) {
      const asOf = addDays(AS_OF, -i);
      const toast = new Set(generateInsights(data, asOf).filter((x) => x.id.startsWith("tracking-break:")).map((x) => x.id.slice("tracking-break:".length)));
      const run = await runMediaBuyerAgent({ data, asOf, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
      const agent = new Set(run.recommendations.filter((r) => r.rule === "tracking-break").map((r) => r.entity.id));
      expect([...toast].sort(), asOf).toEqual([...agent].sort());
    }
  });
});

describe("N4 · dashboard with imperfect inputs", () => {
  it.fails("[BUG2-43] an insight with an unknown severity from a stale file renders a neutral pill, never the literal 'undefined'", async () => {
    const insights = generateInsights(data, AS_OF);
    const narrative = (await provider.run(narrativeTask, { asOf: AS_OF, days: 7, insights })).output;
    const stale = [...insights, { ...insights[0]!, id: "stale", severity: "urgent" as never }];
    const html = renderDashboard({ data, asOf: AS_OF, insights: stale, narrative });
    expect(html).not.toContain("undefined");
  });

  it.fails("[BUG2-44] a one-day window renders every KPI with a comparison against the day before", async () => {
    const insights = generateInsights(data, AS_OF, 1);
    const narrative = (await provider.run(narrativeTask, { asOf: AS_OF, days: 1, insights })).output;
    const html = renderDashboard({ data, asOf: AS_OF, days: 1, insights, narrative });
    expect(html).toContain("vs prev 1d");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

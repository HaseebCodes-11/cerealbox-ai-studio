import { z } from "zod";
import type { AdsDataset } from "../../core/ads";
import { defineTask, type LLMProvider } from "../../core/llm/provider";
import { aggregate, comparePeriods, dailySeries, detectAnomalies, lastNDays, topMovers, totals, type MetricName } from "./metrics";

/**
 * "Ask Toast": natural-language questions over the metrics.
 * Two steps, by design:
 *  1. The LLM translates the question into a typed intent (which metric,
 *     which client, which direction, how many days). It never sees raw data.
 *  2. Code answers the intent deterministically from the aggregation layer.
 * So the numbers in the answer are always real, and the same question gives
 * the same answer on the same data.
 */

export const IntentSchema = z.object({
  intent: z.enum(["rank_clients", "biggest_change", "client_summary", "creative_type_comparison", "anomalies", "portfolio_total", "unknown"]),
  metric: z.enum(["roas", "cpa", "spend", "revenue", "ctr", "conversions", "cpm"]).default("roas"),
  clientName: z.string().optional(),
  direction: z.enum(["up", "down"]).default("down"),
  days: z.number().int().min(1).max(56).default(7),
  limit: z.number().int().min(1).max(20).default(5),
});
export type Intent = z.infer<typeof IntentSchema>;

export interface IntentInput {
  question: string;
  clientNames: string[];
}

export const intentTask = defineTask<IntentInput, Intent>({
  name: "toast.intent",
  description: "Translate a natural-language question into a Toast query intent",
  schema: IntentSchema,
  system: `You translate questions about Meta Ads performance into a structured query. Map the question onto one intent:
- rank_clients: "which clients have the best/worst X"
- biggest_change: "who dropped/improved most on X", "biggest ROAS drop"
- client_summary: a question about one named client
- creative_type_comparison: video vs static vs UGC
- anomalies: "anything unusual", "spikes", "drops"
- portfolio_total: "how much did we spend/raise"
- unknown: anything else
Default to 7 days unless the question says otherwise ("last month" = 28, "yesterday" = 1). Pick the client name from the list if one is mentioned.`,
  effort: "low",
  prompt: ({ question, clientNames }) => `Clients: ${clientNames.join(", ")}\nQuestion: ${question}`,
  mock: ({ question, clientNames }) => parseIntentHeuristically(question, clientNames),
});

export function parseIntentHeuristically(question: string, clientNames: string[]): Intent {
  const q = question.toLowerCase();
  const metric: Intent["metric"] = /\bcpa\b|cost per (donation|acquisition)/.test(q)
    ? "cpa"
    : /\bspend|spent|budget\b/.test(q)
      ? "spend"
      : /\brevenue|raised|income|donations? value\b/.test(q)
        ? "revenue"
        : /\bctr|click[- ]through\b/.test(q)
          ? "ctr"
          : /\bcpm\b/.test(q)
            ? "cpm"
            : /\bconversions?|donations? count|number of donations\b/.test(q)
              ? "conversions"
              : "roas";
  const days = /\blast month|28 days|four weeks\b/.test(q) ? 28 : /\b14 days|two weeks|fortnight\b/.test(q) ? 14 : /\byesterday\b/.test(q) ? 1 : /\b3 days\b/.test(q) ? 3 : 7;
  const direction: Intent["direction"] = /\bdrop|fell|fall|worst|lowest|down|declin|worse\b/.test(q) ? "down" : /\bimprov|best|highest|up|rose|grow|better|top\b/.test(q) ? "up" : "down";
  const clientName = clientNames.find((n) => q.includes(n.toLowerCase()));
  const limitMatch = q.match(/\btop (\d+)\b/);
  const limit = limitMatch ? Math.min(20, Number(limitMatch[1])) : 5;

  let intent: Intent["intent"] = "unknown";
  if (clientName) intent = "client_summary";
  else if (/\bvideo|static|ugc|carousel|creative type|format\b/.test(q)) intent = "creative_type_comparison";
  else if (/\bunusual|anomal|spike|weird|odd|wrong\b/.test(q)) intent = "anomalies";
  else if (/\bbiggest|most|largest|dropped|improved|change|moved\b/.test(q)) intent = "biggest_change";
  else if (/\bwhich client|rank|best|worst|top|lowest|highest\b/.test(q)) intent = "rank_clients";
  else if (/\bhow much|total|overall|in total|altogether\b/.test(q)) intent = "portfolio_total";
  if (intent === "unknown" && metric === "spend") intent = "portfolio_total";

  return { intent, metric, direction, days, limit, ...(clientName ? { clientName } : {}) };
}

export interface Answer {
  question: string;
  intent: Intent;
  text: string;
  table?: { columns: string[]; rows: Array<Array<string | number>> };
  chart?: { label: string; labels: string[]; values: number[] };
  sources: string[];
}

export async function askToast(question: string, data: AdsDataset, asOf: string, provider: LLMProvider): Promise<Answer> {
  const result = await provider.run(intentTask, { question, clientNames: data.clients.map((c) => c.name) });
  return answerIntent(question, result.output, data, asOf);
}

const LOWER_IS_BETTER: Record<MetricName, boolean> = { spend: false, revenue: false, roas: false, cpa: true, ctr: false, conversions: false, cpm: true };

export function answerIntent(question: string, intent: Intent, data: AdsDataset, asOf: string): Answer {
  const period = lastNDays(asOf, intent.days);
  const label = `${intent.days}-day window ending ${asOf}`;
  const m = intent.metric;
  const money = (n: number) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  const fmtMetric = (metric: MetricName, v: number) => (metric === "spend" || metric === "revenue" || metric === "cpa" || metric === "cpm" ? money(v) : metric === "ctr" ? `${v}%` : String(v));

  switch (intent.intent) {
    case "portfolio_total": {
      const t = totals(data, period);
      return {
        question,
        intent,
        text: `Across ${data.clients.length} clients in the ${label}: spend ${money(t.spend)}, raised ${money(t.revenue)} (ROAS ${t.roas}) from ${t.conversions} donations at ${money(t.cpa)} CPA.`,
        table: { columns: ["Spend", "Revenue", "ROAS", "Donations", "CPA", "CTR"], rows: [[t.spend, t.revenue, t.roas, t.conversions, t.cpa, `${t.ctr}%`]] },
        sources: ["aggregate(metrics, client, period)"],
      };
    }
    case "rank_clients": {
      const rows = aggregate(data, "client", period).filter((r) => r.spend > 0);
      const sorted = [...rows].sort((a, b) => {
        const better = LOWER_IS_BETTER[m] ? a[m] - b[m] : b[m] - a[m];
        return intent.direction === "up" ? better : -better;
      });
      const top = sorted.slice(0, intent.limit);
      return {
        question,
        intent,
        text: `${intent.direction === "up" ? "Best" : "Worst"} clients by ${m.toUpperCase()} in the ${label}: ${top.map((r) => `${r.name} (${fmtMetric(m, r[m])})`).join(", ")}.`,
        table: { columns: ["Client", m.toUpperCase(), "Spend", "Revenue", "Donations"], rows: top.map((r) => [r.name, r[m], r.spend, r.revenue, r.conversions]) },
        chart: { label: m.toUpperCase(), labels: top.map((r) => r.name), values: top.map((r) => r[m]) },
        sources: ["aggregate(metrics, client, period)"],
      };
    }
    case "biggest_change": {
      const comparisons = comparePeriods(data, "client", asOf, intent.days);
      // For "drop" on a lower-is-better metric (CPA), a rise is the bad direction.
      const dir = LOWER_IS_BETTER[m] ? (intent.direction === "down" ? "up" : "down") : intent.direction;
      const movers = topMovers(comparisons, m, dir, intent.limit);
      if (!movers.length) return { question, intent, text: `No clients had enough spend to compare ${m.toUpperCase()} across two ${intent.days}-day windows.`, sources: ["comparePeriods"] };
      const lead = movers[0]!;
      return {
        question,
        intent,
        text: `${lead.name} had the biggest ${m.toUpperCase()} ${intent.direction === "down" ? "deterioration" : "improvement"}: ${fmtMetric(m, lead.previous[m])} -> ${fmtMetric(m, lead.recent[m])} (${lead.deltas[m] > 0 ? "+" : ""}${lead.deltas[m]}%) comparing the last ${intent.days} days with the ${intent.days} before.`,
        table: { columns: ["Client", `${m.toUpperCase()} before`, `${m.toUpperCase()} now`, "Change %"], rows: movers.map((c) => [c.name, c.previous[m], c.recent[m], c.deltas[m]]) },
        chart: { label: `${m.toUpperCase()} change %`, labels: movers.map((c) => c.name), values: movers.map((c) => c.deltas[m]) },
        sources: ["comparePeriods(metrics, client)", "topMovers"],
      };
    }
    case "client_summary": {
      const client = data.clients.find((c) => c.name.toLowerCase() === (intent.clientName ?? "").toLowerCase());
      if (!client) return { question, intent, text: `I could not match "${intent.clientName ?? ""}" to a client. Known clients: ${data.clients.map((c) => c.name).join(", ")}.`, sources: [] };
      const cmp = comparePeriods(data, "client", asOf, intent.days).find((c) => c.clientId === client.id);
      const adsets = aggregate(data, "adset", period, { clientId: client.id });
      const series = dailySeries(data, "revenue", period, { clientId: client.id });
      const t = cmp?.recent ?? totals(data, period, { clientId: client.id });
      const vsTarget = t.roas >= client.targetRoas ? "on or above" : "below";
      return {
        question,
        intent,
        text: `${client.name}, ${label}: spend ${money(t.spend)}, raised ${money(t.revenue)}, ROAS ${t.roas} (${vsTarget} the ${client.targetRoas} target), ${t.conversions} donations at ${money(t.cpa)} CPA${cmp ? `; ROAS ${cmp.deltas.roas > 0 ? "+" : ""}${cmp.deltas.roas}% vs the previous period` : ""}. Top ad set by spend: ${adsets[0]?.name ?? "n/a"} (ROAS ${adsets[0]?.roas ?? "n/a"}).`,
        table: { columns: ["Ad set", "Spend", "Revenue", "ROAS", "CPA", "CTR"], rows: adsets.map((a) => [a.name, a.spend, a.revenue, a.roas, a.cpa, `${a.ctr}%`]) },
        chart: { label: "Daily revenue", labels: series.map((p) => p.date.slice(5)), values: series.map((p) => p.value) },
        sources: ["comparePeriods", "aggregate(adset)", "dailySeries(revenue)"],
      };
    }
    case "creative_type_comparison": {
      const rows = aggregate(data, "creativeType", period).sort((a, b) => b.roas - a.roas);
      return {
        question,
        intent,
        text: `By creative type in the ${label}: ${rows.map((r) => `${r.name} ROAS ${r.roas} / CPA ${money(r.cpa)} / CTR ${r.ctr}% on ${money(r.spend)}`).join("; ")}. ${rows[0] ? `${rows[0].name} leads on ROAS.` : ""}`,
        table: { columns: ["Type", "Spend", "Revenue", "ROAS", "CPA", "CTR"], rows: rows.map((r) => [r.name, r.spend, r.revenue, r.roas, r.cpa, `${r.ctr}%`]) },
        chart: { label: "ROAS", labels: rows.map((r) => r.name), values: rows.map((r) => r.roas) },
        sources: ["aggregate(metrics, creativeType, period)"],
      };
    }
    case "anomalies": {
      const long = lastNDays(asOf, Math.max(28, intent.days));
      const anomalies = detectAnomalies(dailySeries(data, "conversions", long), { window: 14, threshold: 2.5 });
      const adsetBreaks = comparePeriods(data, "adset", asOf, 3).filter((a) => a.recent.conversions === 0 && a.recent.linkClicks >= 50 && a.previous.conversions >= 3);
      const parts: string[] = [];
      if (adsetBreaks.length) parts.push(`${adsetBreaks.length} ad set${adsetBreaks.length > 1 ? "s" : ""} recorded zero donations for 3 days despite clicks: ${adsetBreaks.map((a) => a.name).join(", ")} (likely tracking).`);
      if (anomalies.length) parts.push(`Daily donation anomalies: ${anomalies.map((a) => `${a.date} ${a.direction} (${a.value} vs ~${a.expected})`).join("; ")}.`);
      if (!parts.length) parts.push(`Nothing unusual in the last ${long.end === asOf ? 28 : intent.days} days.`);
      return {
        question,
        intent,
        text: parts.join(" "),
        table: adsetBreaks.length ? { columns: ["Ad set", "Clicks (3d)", "Donations (3d)", "Donations (prev 3d)"], rows: adsetBreaks.map((a) => [a.name, a.recent.linkClicks, a.recent.conversions, a.previous.conversions]) } : undefined,
        sources: ["detectAnomalies(dailySeries(conversions))", "comparePeriods(adset, 3)"],
      };
    }
    default:
      return {
        question,
        intent,
        text: `I can answer questions about ROAS, CPA, spend, revenue, CTR and donations by client, creative type, biggest changes, anomalies and totals. Try: "Which client had the biggest ROAS drop last week?"`,
        sources: [],
      };
  }
}

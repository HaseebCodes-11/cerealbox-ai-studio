import { z } from "zod";
import type { AdsDataset } from "../../core/ads";
import { defineTask } from "../../core/llm/provider";
import { aggregate, comparePeriods, dailySeries, detectAnomalies, lastNDays, pacing, topMovers, totals, type Comparison } from "./metrics";
import { capitalise } from "../../core/text";

/**
 * Insight generation is two-stage:
 *  1. Rules compute candidate insights with the exact numbers (no LLM).
 *  2. The LLM turns the top insights into a short executive narrative.
 * The model cannot invent a number because it only ever sees stage-1 output.
 */

export interface Insight {
  id: string;
  severity: "positive" | "info" | "warning" | "critical";
  scope: "portfolio" | "client" | "adset" | "ad" | "creative";
  clientId?: string;
  title: string;
  detail: string;
  metrics: Record<string, number | string>;
  suggestedAction?: string;
}

export function generateInsights(data: AdsDataset, asOf: string, days = 7): Insight[] {
  const insights: Insight[] = [];
  const period = lastNDays(asOf, days);
  const portfolio = comparePeriods(data, "client", asOf, days);
  const total = totals(data, period);
  const prevTotal = totals(data, { start: addDaysSafe(period.start, -days), end: addDaysSafe(period.start, -1) });

  insights.push({
    id: "portfolio-summary",
    severity: total.roas >= 3 ? "positive" : "info",
    scope: "portfolio",
    title: `Portfolio ROAS ${total.roas} on £${fmt(total.spend)} spend`,
    detail: `${data.clients.length} clients raised £${fmt(total.revenue)} from ${total.conversions} donations in the last ${days} days (ROAS ${total.roas}, CPA £${total.cpa}). Previous ${days} days: ROAS ${prevTotal.roas}, £${fmt(prevTotal.revenue)} raised.`,
    metrics: { spend: total.spend, revenue: total.revenue, roas: total.roas, cpa: total.cpa, conversions: total.conversions, prevRoas: prevTotal.roas },
  });

  for (const c of portfolio) {
    const client = data.clients.find((cl) => cl.id === c.clientId);
    if (!client) continue;
    if (c.recent.roas < client.targetRoas * 0.7 && c.recent.spend >= 100) {
      insights.push({
        id: `client-roas-miss:${c.clientId}`,
        severity: "warning",
        scope: "client",
        clientId: c.clientId,
        title: `${c.name} is below ROAS target (${c.recent.roas} vs ${client.targetRoas})`,
        detail: `£${fmt(c.recent.spend)} spent for £${fmt(c.recent.revenue)} raised. CPA £${c.recent.cpa} against a £${client.targetCpaGbp} target. ROAS moved ${signed(c.deltas.roas)}% week on week.`,
        metrics: { roas: c.recent.roas, targetRoas: client.targetRoas, cpa: c.recent.cpa, roasDeltaPct: c.deltas.roas },
        suggestedAction: "Review ad-set level recommendations; consider pausing the weakest ad set and refreshing creative.",
      });
    } else if (c.recent.roas >= client.targetRoas * 1.3 && c.recent.spend >= 100) {
      insights.push({
        id: `client-roas-beat:${c.clientId}`,
        severity: "positive",
        scope: "client",
        clientId: c.clientId,
        title: `${c.name} is beating ROAS target (${c.recent.roas} vs ${client.targetRoas})`,
        detail: `£${fmt(c.recent.revenue)} raised on £${fmt(c.recent.spend)} with CPA £${c.recent.cpa}. There is headroom to scale budget in 20% steps.`,
        metrics: { roas: c.recent.roas, targetRoas: client.targetRoas, cpa: c.recent.cpa },
        suggestedAction: "Approve the scale recommendation on the top ad set.",
      });
    }
    if (Math.abs(c.deltas.revenue) >= 25 && c.previous.spend >= 100) {
      insights.push({
        id: `client-revenue-swing:${c.clientId}`,
        severity: c.deltas.revenue < 0 ? "warning" : "info",
        scope: "client",
        clientId: c.clientId,
        title: `${c.name} revenue ${c.deltas.revenue < 0 ? "down" : "up"} ${Math.abs(c.deltas.revenue)}% week on week`,
        detail: `£${fmt(c.previous.revenue)} -> £${fmt(c.recent.revenue)} with spend ${signed(c.deltas.spend)}% and CPA ${signed(c.deltas.cpa)}%.`,
        metrics: { revenueDeltaPct: c.deltas.revenue, spendDeltaPct: c.deltas.spend, cpaDeltaPct: c.deltas.cpa },
      });
    }
    const pace = pacing(data, period, c.clientId);
    if (pace.budgeted > 0 && (pace.pacePct < 80 || pace.pacePct > 110)) {
      insights.push({
        id: `client-pacing:${c.clientId}`,
        severity: "info",
        scope: "client",
        clientId: c.clientId,
        title: `${c.name} spend pacing at ${pace.pacePct}% of budget`,
        detail: `£${fmt(pace.actual)} delivered against £${fmt(pace.budgeted)} budgeted over ${days} days.`,
        metrics: { pacePct: pace.pacePct, budgeted: pace.budgeted, actual: pace.actual },
        suggestedAction: pace.pacePct < 80 ? "Check for learning-limited ad sets or audience saturation." : "Check budget caps and bid strategy.",
      });
    }
  }

  // Tracking break detection at ad set level: conversions collapse while clicks continue.
  const adsetCompare = comparePeriods(data, "adset", asOf, 3);
  for (const a of adsetCompare) {
    if (a.recent.conversions === 0 && a.recent.linkClicks >= 50 && a.previous.conversions >= 3) {
      insights.push({
        id: `tracking-break:${a.key}`,
        severity: "critical",
        scope: "adset",
        clientId: a.clientId,
        title: `Zero donations recorded on ${a.name} for 3 days despite ${a.recent.linkClicks} clicks`,
        detail: `Previous 3 days had ${a.previous.conversions} donations. This pattern usually means the pixel, Conversions API or donation-platform webhook stopped firing, not that donors stopped giving.`,
        metrics: { linkClicks3d: a.recent.linkClicks, conversions3d: 0, conversionsPrev3d: a.previous.conversions },
        suggestedAction: "Check Events Manager and the fundraising platform webhook log before changing any budgets.",
      });
    }
  }

  // Creative type comparison.
  const byType = aggregate(data, "creativeType", period);
  if (byType.length >= 2) {
    const sorted = [...byType].sort((a, b) => b.roas - a.roas);
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    insights.push({
      id: "creative-type-comparison",
      severity: "info",
      scope: "creative",
      title: `${capitalise(best.name)} creatives lead on ROAS (${best.roas}) vs ${worst.name} (${worst.roas})`,
      detail: byType.map((t) => `${t.name}: ROAS ${t.roas}, CPA £${t.cpa}, CTR ${t.ctr}% on £${fmt(t.spend)}`).join(" · "),
      metrics: Object.fromEntries(byType.map((t) => [`${t.name}Roas`, t.roas])),
      suggestedAction: `Brief more ${best.name} variants from the idea bank.`,
    });
  }

  // Movers.
  const movers = topMovers(portfolio, "cpa", "up", 1);
  for (const m of movers) {
    if (m.deltas.cpa >= 40) {
      insights.push({
        id: `cpa-mover:${m.clientId}`,
        severity: "warning",
        scope: "client",
        clientId: m.clientId,
        title: `${m.name} CPA up ${m.deltas.cpa}% week on week (£${m.previous.cpa} -> £${m.recent.cpa})`,
        detail: `Conversions ${signed(m.deltas.conversions)}% on spend ${signed(m.deltas.spend)}%.`,
        metrics: { cpaRecent: m.recent.cpa, cpaPrevious: m.previous.cpa, cpaDeltaPct: m.deltas.cpa },
      });
    }
  }

  // Daily anomalies on portfolio revenue.
  const longPeriod = lastNDays(asOf, 28);
  const revenueAnomalies = detectAnomalies(dailySeries(data, "revenue", longPeriod), { window: 14, threshold: 2.5 });
  for (const a of revenueAnomalies.slice(-2)) {
    insights.push({
      id: `anomaly-revenue:${a.date}`,
      severity: a.direction === "low" ? "warning" : "info",
      scope: "portfolio",
      title: `Portfolio revenue ${a.direction === "low" ? "dropped" : "spiked"} on ${a.date}`,
      detail: `£${fmt(a.value)} vs an expected ~£${fmt(a.expected)} (z=${a.zScore}).`,
      metrics: { value: a.value, expected: a.expected, z: a.zScore },
    });
  }

  const order = { critical: 0, warning: 1, positive: 2, info: 3 };
  return insights.sort((x, y) => order[x.severity] - order[y.severity] || x.id.localeCompare(y.id));
}

export const NarrativeSchema = z.object({
  headline: z.string().min(5),
  paragraphs: z.array(z.string().min(20)).min(1).max(4),
  actionsToday: z.array(z.string().min(5)).max(5),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

export interface NarrativeInput {
  asOf: string;
  days: number;
  insights: Array<Pick<Insight, "id" | "severity" | "title" | "detail" | "suggestedAction">>;
}

export const narrativeTask = defineTask<NarrativeInput, Narrative>({
  name: "toast.narrative",
  description: "Write an executive summary from computed insights",
  schema: NarrativeSchema,
  system: `You write the weekly performance summary for a charity-focused paid media agency.
You receive insights with exact figures. Use only those figures. Never estimate or extrapolate a number that is not given.
Be concise and specific: what happened, why it matters for fundraising, what we are doing about it. Plain English for charity leadership.`,
  effort: "low",
  prompt: (input) => [`Week ending ${input.asOf} (${input.days} days).`, `Insights:`, ...input.insights.map((i) => `- [${i.severity}] ${i.title}. ${i.detail}${i.suggestedAction ? ` Suggested: ${i.suggestedAction}` : ""}`)].join("\n"),
  mock: (input) => {
    const critical = input.insights.filter((i) => i.severity === "critical");
    const warnings = input.insights.filter((i) => i.severity === "warning");
    const positives = input.insights.filter((i) => i.severity === "positive");
    const summary = input.insights.find((i) => i.id === "portfolio-summary");
    const paragraphs = [
      summary ? `${summary.detail}` : `Portfolio performance for the week ending ${input.asOf}.`,
      critical.length ? `Urgent: ${critical.map((c) => c.title.toLowerCase()).join("; ")}. ${critical[0]?.suggestedAction ?? ""}`.trim() : `No tracking or delivery incidents detected this week.`,
      warnings.length ? `Watch: ${warnings.map((w) => w.title).join("; ")}.` : `No clients are below their ROAS floor this week.`,
      positives.length ? `Good news: ${positives.map((p) => p.title).join("; ")}.` : `No clients are beating target by more than 30% yet; scaling opportunities will appear as creative tests mature.`,
    ];
    return {
      headline: critical.length ? `${critical.length} urgent item${critical.length > 1 ? "s" : ""} and ${warnings.length} to watch` : warnings.length ? `${warnings.length} client${warnings.length > 1 ? "s" : ""} need attention this week` : `Steady week across the portfolio`,
      paragraphs,
      actionsToday: input.insights
        .filter((i) => i.suggestedAction && (i.severity === "critical" || i.severity === "warning" || i.severity === "positive"))
        .slice(0, 5)
        .map((i) => i.suggestedAction!),
    };
  },
});

function fmt(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}
function addDaysSafe(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function insightsToMarkdown(insights: Insight[]): string {
  const icon = { critical: "🔴", warning: "🟠", positive: "🟢", info: "🔵" };
  return insights.map((i) => `- ${icon[i.severity]} **${i.title}** — ${i.detail}${i.suggestedAction ? `\n  - Suggested: ${i.suggestedAction}` : ""}`).join("\n");
}

export type { Comparison };

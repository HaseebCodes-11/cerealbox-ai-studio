import { addDays, dedupeMetrics, derive, round2, sumMetrics, type AdMetricsDaily, type AdsDataset, type Derived } from "../../core/ads";

/**
 * Pure aggregation layer. Everything Toast shows and everything "Ask Toast"
 * answers is computed here, deterministically, from the metrics table.
 * The LLM only ever narrates numbers that came out of these functions.
 */

export type GroupBy = "client" | "campaign" | "adset" | "ad" | "creativeType";

export interface AggregateRow extends Derived {
  key: string;
  name: string;
  clientId: string;
  clientName: string;
}

export interface Period {
  start: string;
  end: string;
}

export function lastNDays(asOf: string, n: number): Period {
  return { start: addDays(asOf, -(n - 1)), end: asOf };
}

export function previousPeriod(p: Period): Period {
  const len = Math.round((new Date(`${p.end}T00:00:00Z`).getTime() - new Date(`${p.start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  return { start: addDays(p.start, -len), end: addDays(p.start, -1) };
}

export function inPeriod(rows: AdMetricsDaily[], p: Period): AdMetricsDaily[] {
  // Re-synced days arrive as duplicate rows; the last write wins so nothing is counted twice.
  return dedupeMetrics(rows.filter((r) => r.date >= p.start && r.date <= p.end));
}

export function aggregate(data: AdsDataset, groupBy: GroupBy, period: Period, filter: { clientId?: string } = {}): AggregateRow[] {
  const clientName = new Map(data.clients.map((c) => [c.id, c.name]));
  const campaignName = new Map(data.campaigns.map((c) => [c.id, c.name]));
  const adsetName = new Map(data.adsets.map((a) => [a.id, a.name]));
  const adById = new Map(data.ads.map((a) => [a.id, a]));

  const groups = new Map<string, { name: string; clientId: string; rows: AdMetricsDaily[] }>();
  for (const row of inPeriod(data.metrics, period)) {
    if (filter.clientId && row.clientId !== filter.clientId) continue;
    let key: string;
    let name: string;
    switch (groupBy) {
      case "client":
        key = row.clientId;
        name = clientName.get(row.clientId) ?? row.clientId;
        break;
      case "campaign":
        key = row.campaignId;
        name = campaignName.get(row.campaignId) ?? row.campaignId;
        break;
      case "adset":
        key = row.adsetId;
        name = adsetName.get(row.adsetId) ?? row.adsetId;
        break;
      case "ad":
        key = row.adId;
        name = adById.get(row.adId)?.name ?? row.adId;
        break;
      case "creativeType":
        key = adById.get(row.adId)?.creativeType ?? "unknown";
        name = key;
        break;
    }
    const group = groups.get(key) ?? { name, clientId: groupBy === "creativeType" ? "all" : row.clientId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const out: AggregateRow[] = [];
  for (const [key, g] of groups) {
    out.push({ key, name: g.name, clientId: g.clientId, clientName: clientName.get(g.clientId) ?? (g.clientId === "all" ? "All clients" : g.clientId), ...derive(sumMetrics(g.rows)) });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

export function totals(data: AdsDataset, period: Period, filter: { clientId?: string } = {}): Derived {
  const rows = inPeriod(data.metrics, period).filter((r) => !filter.clientId || r.clientId === filter.clientId);
  return derive(sumMetrics(rows));
}

export interface Comparison {
  key: string;
  name: string;
  clientId: string;
  recent: Derived;
  previous: Derived;
  /** False when the previous period had no delivery: deltas are then 0 and should be shown as "n/a". */
  hasBaseline: boolean;
  deltas: Record<"spend" | "revenue" | "roas" | "cpa" | "ctr" | "conversions" | "cpm", number>; // % change
}

export function pctChange(now: number, before: number): number {
  if (before === 0) return now === 0 ? 0 : 100;
  return round2(((now - before) / before) * 100);
}

export function comparePeriods(data: AdsDataset, groupBy: GroupBy, asOf: string, days = 7, filter: { clientId?: string } = {}): Comparison[] {
  const recentP = lastNDays(asOf, days);
  const prevP = previousPeriod(recentP);
  const recent = aggregate(data, groupBy, recentP, filter);
  const previous = new Map(aggregate(data, groupBy, prevP, filter).map((r) => [r.key, r]));
  return recent.map((r) => {
    const p = previous.get(r.key) ?? { ...r, ...derive(sumMetrics([])) };
    const hasBaseline = p.spend > 0 || p.impressions > 0;
    const delta = (now: number, before: number) => (hasBaseline ? pctChange(now, before) : 0);
    return {
      key: r.key,
      name: r.name,
      clientId: r.clientId,
      recent: r,
      previous: p,
      hasBaseline,
      deltas: {
        spend: delta(r.spend, p.spend),
        revenue: delta(r.revenue, p.revenue),
        roas: delta(r.roas, p.roas),
        cpa: delta(r.cpa, p.cpa),
        ctr: delta(r.ctr, p.ctr),
        conversions: delta(r.conversions, p.conversions),
        cpm: delta(r.cpm, p.cpm),
      },
    };
  });
}

export type MetricName = keyof Comparison["deltas"];

export function topMovers(comparisons: Comparison[], metric: MetricName, direction: "up" | "down", n = 3, minSpend = 50): Comparison[] {
  const eligible = comparisons.filter((c) => c.hasBaseline && c.recent.spend >= minSpend && c.previous.spend >= minSpend);
  const sorted = [...eligible].sort((a, b) => (direction === "up" ? b.deltas[metric] - a.deltas[metric] : a.deltas[metric] - b.deltas[metric]));
  return sorted.slice(0, n);
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export function dailySeries(data: AdsDataset, metric: "spend" | "revenue" | "conversions" | "roas" | "cpa" | "ctr", period: Period, filter: { clientId?: string; adsetId?: string } = {}): SeriesPoint[] {
  const byDate = new Map<string, AdMetricsDaily[]>();
  for (const row of inPeriod(data.metrics, period)) {
    if (filter.clientId && row.clientId !== filter.clientId) continue;
    if (filter.adsetId && row.adsetId !== filter.adsetId) continue;
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  const out: SeriesPoint[] = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    const derived = derive(sumMetrics(byDate.get(d) ?? []));
    out.push({ date: d, value: derived[metric] });
  }
  return out;
}

export interface Anomaly {
  date: string;
  value: number;
  expected: number;
  zScore: number;
  direction: "high" | "low";
}

/** Rolling z-score anomaly detection on a daily series. */
export function detectAnomalies(series: SeriesPoint[], options: { window?: number; threshold?: number } = {}): Anomaly[] {
  const window = options.window ?? 14;
  const threshold = options.threshold ?? 2.5;
  const out: Anomaly[] = [];
  for (let i = window; i < series.length; i++) {
    const hist = series.slice(i - window, i).map((p) => p.value);
    const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
    const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length;
    const sd = Math.sqrt(variance);
    const point = series[i]!;
    if (sd === 0) {
      if (point.value !== mean && mean > 0) out.push({ date: point.date, value: point.value, expected: round2(mean), zScore: point.value > mean ? 99 : -99, direction: point.value > mean ? "high" : "low" });
      continue;
    }
    const z = (point.value - mean) / sd;
    if (Math.abs(z) >= threshold) {
      out.push({ date: point.date, value: point.value, expected: round2(mean), zScore: round2(z), direction: z > 0 ? "high" : "low" });
    }
  }
  return out;
}

/** Spend pacing: how far actual spend is from budget over the period. */
export function pacing(data: AdsDataset, period: Period, clientId: string): { budgeted: number; actual: number; pacePct: number } {
  const days = Math.round((new Date(`${period.end}T00:00:00Z`).getTime() - new Date(`${period.start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  const budgeted = data.adsets.filter((a) => a.clientId === clientId && a.status === "ACTIVE").reduce((s, a) => s + a.dailyBudgetGbp, 0) * days;
  const actual = totals(data, period, { clientId }).spend;
  return { budgeted: round2(budgeted), actual: round2(actual), pacePct: budgeted > 0 ? round2((actual / budgeted) * 100) : 0 };
}

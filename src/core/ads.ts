import { round2 } from "./num";
import { z } from "zod";

/**
 * Shared ad-data model. This mirrors what True ROAS already stores: Meta
 * entities (client -> campaign -> ad set -> ad) plus a daily metrics fact
 * table joined to donation revenue. Toast reads it for reporting; the Media
 * Buyer agent reads it for decisions. One model, two consumers.
 */

export const ClientRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  adAccountId: z.string().min(1),
  targetRoas: z.number().positive(),
  targetCpaGbp: z.number().positive(),
});

export const CampaignRefSchema = z.object({
  id: z.string().min(1),
  clientId: z.string().min(1),
  name: z.string().min(1),
  objective: z.enum(["donations", "regular_giving", "leads", "awareness"]),
  status: z.enum(["ACTIVE", "PAUSED"]),
});

export const AdSetRefSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  clientId: z.string().min(1),
  name: z.string().min(1),
  dailyBudgetGbp: z.number().positive(),
  status: z.enum(["ACTIVE", "PAUSED"]),
  learningStatus: z.enum(["learning", "learning_limited", "active"]).default("active"),
});

export const AdRefSchema = z.object({
  id: z.string().min(1),
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  clientId: z.string().min(1),
  name: z.string().min(1),
  creativeType: z.enum(["static", "video", "ugc", "carousel"]),
  status: z.enum(["ACTIVE", "PAUSED"]),
  launchedOn: z.string(),
});

export const AdMetricsDailySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clientId: z.string().min(1),
  campaignId: z.string().min(1),
  adsetId: z.string().min(1),
  adId: z.string().min(1),
  spend: z.number().nonnegative(),
  impressions: z.number().int().nonnegative(),
  reach: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  linkClicks: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  revenue: z.number().nonnegative(),
});

export type ClientRef = z.infer<typeof ClientRefSchema>;
export type CampaignRef = z.infer<typeof CampaignRefSchema>;
export type AdSetRef = z.infer<typeof AdSetRefSchema>;
export type AdRef = z.infer<typeof AdRefSchema>;
export type AdMetricsDaily = z.infer<typeof AdMetricsDailySchema>;

export interface AdsDataset {
  clients: ClientRef[];
  campaigns: CampaignRef[];
  adsets: AdSetRef[];
  ads: AdRef[];
  metrics: AdMetricsDaily[];
  /** Inclusive date range covered by metrics. */
  range: { start: string; end: string };
}

export interface Totals {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  conversions: number;
  revenue: number;
}

export interface Derived extends Totals {
  ctr: number; // %
  cpc: number;
  cpm: number;
  cpa: number;
  roas: number;
  conversionRate: number; // %
  frequency: number;
  avgGift: number;
}

export const EMPTY_TOTALS: Totals = { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, conversions: 0, revenue: 0 };

/**
 * A re-synced day arrives as duplicate (date, adId) rows. Keep the last one so
 * nothing is counted twice; the sync's most recent values win.
 */
export function dedupeMetrics(rows: AdMetricsDaily[]): AdMetricsDaily[] {
  const byKey = new Map<string, AdMetricsDaily>();
  for (const row of rows) byKey.set(`${row.date}|${row.adId}`, row);
  return [...byKey.values()];
}

export function sumMetrics(rows: Iterable<AdMetricsDaily>): Totals {
  const t: Totals = { ...EMPTY_TOTALS };
  for (const r of rows) {
    t.spend += r.spend;
    t.impressions += r.impressions;
    t.reach += r.reach;
    t.clicks += r.clicks;
    t.linkClicks += r.linkClicks;
    t.conversions += r.conversions;
    t.revenue += r.revenue;
  }
  return t;
}

export function derive(t: Totals): Derived {
  const safe = (n: number, d: number) => (d > 0 ? n / d : 0);
  return {
    ...t,
    spend: round2(t.spend),
    revenue: round2(t.revenue),
    ctr: round2(safe(t.linkClicks, t.impressions) * 100),
    cpc: round2(safe(t.spend, t.linkClicks)),
    cpm: round2(safe(t.spend, t.impressions) * 1000),
    cpa: round2(safe(t.spend, t.conversions)),
    roas: round2(safe(t.revenue, t.spend)),
    conversionRate: round2(safe(t.conversions, t.linkClicks) * 100),
    frequency: round2(safe(t.impressions, t.reach)),
    avgGift: round2(safe(t.revenue, t.conversions)),
  };
}

export { round2 } from "./num";

/** ISO date helpers (UTC, no time component). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

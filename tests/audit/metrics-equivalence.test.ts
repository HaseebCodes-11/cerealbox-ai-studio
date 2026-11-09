/**
 * PERF-03 guard: the memoised `inPeriod` must return exactly what the naive
 * filter-then-dedupe implementation returned, row for row and in the same
 * order, for any dataset including duplicate rows, and must notice when the
 * underlying array grows.
 */
import { describe, expect, it } from "vitest";
import { dedupeMetrics, type AdMetricsDaily } from "../../src/core/ads";
import { Rng } from "../../src/core/rng";
import { aggregate, comparePeriods, dedupedMetrics, inPeriod, lastNDays, totals } from "../../src/areas/toast/metrics";
import { generateMockDataset } from "../../src/areas/toast";

function naive(rows: AdMetricsDaily[], p: { start: string; end: string }): AdMetricsDaily[] {
  return dedupeMetrics(rows.filter((r) => r.date >= p.start && r.date <= p.end));
}

function randomRows(rng: Rng, n: number): AdMetricsDaily[] {
  const rows: AdMetricsDaily[] = [];
  for (let i = 0; i < n; i++) {
    const day = 1 + rng.int(0, 27);
    const row: AdMetricsDaily = {
      date: `2026-10-${String(day).padStart(2, "0")}`,
      clientId: `c${rng.int(1, 3)}`,
      campaignId: `cp${rng.int(1, 4)}`,
      adsetId: `as${rng.int(1, 6)}`,
      adId: `ad${rng.int(1, 12)}`,
      impressions: rng.int(0, 5000),
      reach: rng.int(0, 4000),
      clicks: rng.int(0, 200),
      linkClicks: rng.int(0, 150),
      spend: rng.int(0, 20000) / 100,
      conversions: rng.int(0, 20),
      revenue: rng.int(0, 60000) / 100,
    };
    rows.push(row);
    // Inject re-sync duplicates (same date|adId, different numbers) some of the time.
    if (rng.next() < 0.2) rows.push({ ...row, spend: row.spend + 1, impressions: row.impressions + 10 });
  }
  return rows;
}

describe("inPeriod memoisation is observationally identical to filter-then-dedupe", () => {
  it("matches on 200 random datasets with duplicates, several periods each", () => {
    const rng = new Rng(20261108);
    for (let i = 0; i < 200; i++) {
      const rows = randomRows(rng, rng.int(0, 400));
      for (let k = 0; k < 3; k++) {
        const start = `2026-10-${String(1 + rng.int(0, 20)).padStart(2, "0")}`;
        const end = `2026-10-${String(Math.min(28, Number(start.slice(-2)) + rng.int(0, 10))).padStart(2, "0")}`;
        expect(inPeriod(rows, { start, end })).toEqual(naive(rows, { start, end }));
      }
    }
  });

  it("returns the same object identity for repeated calls and recomputes after the array grows", () => {
    const rows = randomRows(new Rng(7), 50);
    const a = dedupedMetrics(rows);
    expect(dedupedMetrics(rows)).toBe(a);
    rows.push({ ...rows[0]!, spend: 999 });
    const b = dedupedMetrics(rows);
    expect(b).not.toBe(a);
    expect(b).toEqual(dedupeMetrics(rows));
    expect(inPeriod(rows, { start: "2026-10-01", end: "2026-10-28" })).toEqual(naive(rows, { start: "2026-10-01", end: "2026-10-28" }));
  });

  it("does not change aggregate, totals or comparePeriods on the demo dataset", () => {
    const asOf = "2026-11-08";
    const data = generateMockDataset({ asOf });
    const period = lastNDays(asOf, 7);
    const naiveData = { ...data, metrics: naive(data.metrics, { start: "2000-01-01", end: "2999-12-31" }) };
    expect(aggregate(data, "client", period)).toEqual(aggregate(naiveData, "client", period));
    expect(aggregate(data, "creativeType", period)).toEqual(aggregate(naiveData, "creativeType", period));
    expect(totals(data, period)).toEqual(totals(naiveData, period));
    expect(comparePeriods(data, "adset", asOf, 7)).toEqual(comparePeriods(naiveData, "adset", asOf, 7));
  });
});

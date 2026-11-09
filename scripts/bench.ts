/**
 * Micro-benchmarks for the hot paths, run against a scaled dataset:
 *   npx tsx scripts/bench.ts [clients=30] [days=365]
 * Prints wall-clock per stage. Used as evidence in docs/AUDIT.md and by the
 * performance regression tests (tests/perf/*.test.ts) with relaxed thresholds.
 */
import { performance } from "node:perf_hooks";
import type { AdsDataset } from "../src/core/ads";
import { MockProvider } from "../src/core/llm";
import { RulesConfigSchema, buildWindows, evaluateRules, runMediaBuyerAgent, MockMetaAdsClient } from "../src/areas/media-buyer";
import { generateInsights, generateMockDataset, comparePeriods, renderDashboard, narrativeTask } from "../src/areas/toast";
import { checkText } from "../src/core/guardrails";
import { runCampaignPipeline } from "../src/orchestrator";
import { parseBrief } from "../src/core/brief";
import { readFileSync } from "node:fs";

export function scaledDataset(clients: number, days: number, asOf = "2026-11-08"): AdsDataset {
  const base = generateMockDataset({ asOf, days });
  const copies = Math.ceil(clients / base.clients.length);
  const out: AdsDataset = { clients: [], campaigns: [], adsets: [], ads: [], metrics: [], range: base.range };
  for (let i = 0; i < copies; i++) {
    const suffix = i === 0 ? "" : `-${i}`;
    out.clients.push(...base.clients.map((c) => ({ ...c, id: `${c.id}${suffix}`, name: `${c.name}${suffix ? ` ${i}` : ""}` })));
    out.campaigns.push(...base.campaigns.map((c) => ({ ...c, id: `${c.id}${suffix}`, clientId: `${c.clientId}${suffix}` })));
    out.adsets.push(...base.adsets.map((a) => ({ ...a, id: `${a.id}${suffix}`, campaignId: `${a.campaignId}${suffix}`, clientId: `${a.clientId}${suffix}` })));
    out.ads.push(...base.ads.map((a) => ({ ...a, id: `${a.id}${suffix}`, adsetId: `${a.adsetId}${suffix}`, campaignId: `${a.campaignId}${suffix}`, clientId: `${a.clientId}${suffix}` })));
    out.metrics.push(...base.metrics.map((m) => ({ ...m, clientId: `${m.clientId}${suffix}`, campaignId: `${m.campaignId}${suffix}`, adsetId: `${m.adsetId}${suffix}`, adId: `${m.adId}${suffix}` })));
  }
  out.clients = out.clients.slice(0, clients);
  const keep = new Set(out.clients.map((c) => c.id));
  out.campaigns = out.campaigns.filter((c) => keep.has(c.clientId));
  out.adsets = out.adsets.filter((a) => keep.has(a.clientId));
  out.ads = out.ads.filter((a) => keep.has(a.clientId));
  out.metrics = out.metrics.filter((m) => keep.has(m.clientId));
  return out;
}

export async function time<T>(label: string, fn: () => T | Promise<T>): Promise<{ label: string; ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  const ms = Math.round((performance.now() - start) * 10) / 10;
  return { label, ms, result };
}

async function main(): Promise<void> {
  const clients = Number(process.argv[2] ?? 30);
  const days = Number(process.argv[3] ?? 365);
  const asOf = "2026-11-08";
  const data = scaledDataset(clients, days, asOf);
  console.log(`dataset: ${data.clients.length} clients, ${data.adsets.length} ad sets, ${data.ads.length} ads, ${data.metrics.length.toLocaleString()} daily rows over ${days} days`);
  const config = RulesConfigSchema.parse({});
  const provider = new MockProvider();
  const rows: Array<{ label: string; ms: number }> = [];
  const push = <T>(r: { label: string; ms: number; result: T }) => (rows.push({ label: r.label, ms: r.ms }), r.result);

  const windows = push(await time("agent: buildWindows", () => buildWindows(data, asOf, config)));
  push(await time("agent: evaluateRules", () => evaluateRules(windows, config, asOf)));
  push(await time("agent: full run (mock LLM)", () => runMediaBuyerAgent({ data, asOf, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist" })));
  push(await time("toast: comparePeriods(client)", () => comparePeriods(data, "client", asOf, 7)));
  const insights = push(await time("toast: generateInsights", () => generateInsights(data, asOf)));
  const narrative = (await provider.run(narrativeTask, { asOf, days: 7, insights })).output;
  push(await time("toast: renderDashboard", () => renderDashboard({ data, asOf, insights, narrative })));
  const long = "Donate today and help an older person stay warm. £30 covers a week of heating for one household. ".repeat(50);
  push(await time("guardrails: checkText x200 (10 KB each)", () => { for (let i = 0; i < 200; i++) checkText(long, { allowedFacts: ["£30 covers a week of heating for one household"], avoidWords: ["vulnerable", "the elderly", "victims"] }); }));
  const brief = parseBrief(JSON.parse(readFileSync("samples/brief-winter-warmth.json", "utf8")));
  push(await time("pipeline: full campaign (mock LLM, no render)", () => runCampaignPipeline({ brief, provider })));

  console.log("\n| Stage | ms |\n|---|---:|");
  for (const r of rows) console.log(`| ${r.label} | ${r.ms} |`);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/bench.ts");
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });

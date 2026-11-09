import type { AdsDataset } from "../../core/ads";
import { defineTask } from "../../core/llm/provider";
import { escapeHtml } from "../../core/text";
import type { Recommendation } from "../media-buyer/types";
import type { Insight } from "../toast/insights";
import { aggregate, comparePeriods, lastNDays } from "../toast/metrics";
import { ClientReportNarrativeSchema, type ClientReportInput, type ClientReportNarrative, type NumberCheck, type ReportFigures } from "./types";

/** Map internal recommendation types to language a charity trustee can read. */
const CLIENT_SAFE_ACTIONS: Record<Recommendation["type"], string> = {
  pause_ad: "We are retiring an ad that was not bringing in donations and moving its budget to ones that are.",
  pause_adset: "We are pausing an audience group that is not delivering value and will re-plan it with you.",
  increase_budget: "One audience is performing well above target, so we are increasing its budget in a measured step.",
  decrease_budget: "We are trimming budget on an audience whose cost per donation has risen while we refresh its creative.",
  refresh_creative: "One ad has been seen too often by the same people; a fresh creative is in production.",
  investigate_tracking: "We spotted a possible tracking issue and are checking it with your donation platform before changing anything.",
  exit_learning_limited: "One audience is too small for Meta to optimise well; we are consolidating audiences so your budget works harder.",
  notify: "Nothing to action; we are keeping an eye on it.",
};

export function buildClientReportInput(data: AdsDataset, insights: Insight[], recommendations: Recommendation[], clientId: string, asOf: string, days = 7): ClientReportInput {
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client ${clientId}`);
  const cmp = comparePeriods(data, "client", asOf, days).find((c) => c.clientId === clientId);
  const period = lastNDays(asOf, days);
  const adsets = aggregate(data, "adset", period, { clientId }).map((a) => ({ name: a.name, spend: a.spend, revenue: a.revenue, roas: a.roas, conversions: a.conversions }));
  const ads = aggregate(data, "ad", period, { clientId }).filter((a) => a.spend >= 50 && a.conversions >= 3);
  const adById = new Map(data.ads.map((a) => [a.id, a]));
  const best = [...ads].sort((a, b) => b.roas - a.roas)[0];
  const toFigures = (d: { spend: number; revenue: number; roas: number; conversions: number; cpa: number; avgGift: number } | undefined): ReportFigures => ({
    spend: d?.spend ?? 0,
    revenue: d?.revenue ?? 0,
    roas: d?.roas ?? 0,
    conversions: d?.conversions ?? 0,
    cpa: d?.cpa ?? 0,
    avgGift: d?.avgGift ?? 0,
  });
  return {
    clientId,
    clientName: client.name,
    asOf,
    days,
    targetRoas: client.targetRoas,
    current: toFigures(cmp?.recent),
    previous: toFigures(cmp?.previous),
    deltasPct: { spend: cmp?.deltas.spend ?? 0, revenue: cmp?.deltas.revenue ?? 0, roas: cmp?.deltas.roas ?? 0, conversions: cmp?.deltas.conversions ?? 0, cpa: cmp?.deltas.cpa ?? 0 },
    adsets,
    topCreative: best ? { name: best.name, type: adById.get(best.key)?.creativeType ?? "unknown", roas: best.roas } : null,
    insights: insights.filter((i) => i.clientId === clientId).map((i) => ({ severity: i.severity, title: i.title, detail: i.detail })),
    actions: [...new Set(recommendations.filter((r) => r.entity.clientId === clientId).map((r) => CLIENT_SAFE_ACTIONS[r.type]))],
  };
}

const SYSTEM = `You write the weekly performance update a charity's fundraising director receives from their agency.
Use only the figures provided. Never estimate, round differently, or add a number that is not in the input.
Plain English, no advertising jargon (say "audience" not "ad set", "cost per donation" not "CPA", "return" not "ROAS" except once with the figure).
Be straight about problems and specific about what the agency is doing next. Warm, not salesy.`;

export const clientReportTask = defineTask<ClientReportInput, ClientReportNarrative>({
  name: "reporting.clientNarrative",
  description: "Write a client-safe weekly report narrative from computed figures",
  schema: ClientReportNarrativeSchema,
  system: SYSTEM,
  effort: "low",
  prompt: (input) =>
    [
      `Client: ${input.clientName}. Week ending ${input.asOf} (${input.days} days). Target return: ${input.targetRoas}x.`,
      `This period: spend £${input.current.spend}, raised £${input.current.revenue}, return ${input.current.roas}x, donations ${input.current.conversions}, cost per donation £${input.current.cpa}, average gift £${input.current.avgGift}.`,
      `Previous period: spend £${input.previous.spend}, raised £${input.previous.revenue}, return ${input.previous.roas}x, donations ${input.previous.conversions}, cost per donation £${input.previous.cpa}.`,
      `Changes: spend ${input.deltasPct.spend}%, raised ${input.deltasPct.revenue}%, return ${input.deltasPct.roas}%, donations ${input.deltasPct.conversions}%, cost per donation ${input.deltasPct.cpa}%.`,
      input.topCreative ? `Best creative: ${input.topCreative.name} (${input.topCreative.type}) at ${input.topCreative.roas}x.` : "",
      `Audiences: ${input.adsets.map((a) => `${a.name}: £${a.spend} spend, £${a.revenue} raised, ${a.roas}x, ${a.conversions} donations`).join("; ")}.`,
      input.insights.length ? `Notes: ${input.insights.map((i) => `[${i.severity}] ${i.title}`).join("; ")}.` : "",
      input.actions.length ? `What we are doing (say these in your own words but keep the meaning): ${input.actions.join(" | ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  mock: (input) => mockNarrative(input),
});

export function mockNarrative(input: ClientReportInput): ClientReportNarrative {
  // Clients read whole pounds; the verifier accepts rounded forms of every input figure.
  const round = (f: ReportFigures): ReportFigures => ({ spend: Math.round(f.spend), revenue: Math.round(f.revenue), roas: f.roas, conversions: f.conversions, cpa: Math.round(f.cpa), avgGift: Math.round(f.avgGift) });
  input = { ...input, current: round(input.current), previous: round(input.previous), adsets: input.adsets.map((a) => ({ ...a, spend: Math.round(a.spend), revenue: Math.round(a.revenue) })) };
  const c = input.current;
  if (c.spend === 0 && c.conversions === 0) {
    return {
      headline: `${input.clientName}: no advertising ran this period`,
      summary: [
        `No advertising activity was recorded for ${input.clientName} in the ${input.days} days to ${input.asOf}, so there are no results to report. The previous period raised £${fmt(input.previous.revenue)} from ${input.previous.conversions} donations.`,
      ],
      highlights: [],
      concerns: ["Campaigns were paused or did not deliver; we are confirming the reason with you before restarting."],
      nextSteps: input.actions.length ? input.actions.slice(0, 4) : ["Agree the restart date and budget, then resume with the best-performing audiences first."],
    };
  }
  const onTarget = c.roas >= input.targetRoas;
  const direction = input.deltasPct.revenue >= 0 ? "up" : "down";
  const headline = onTarget ? `${input.clientName}: £${fmt(c.revenue)} raised, ahead of target` : `${input.clientName}: £${fmt(c.revenue)} raised, working to get back to target`;
  const summary = [
    `Over the ${input.days} days to ${input.asOf} your campaigns raised £${fmt(c.revenue)} from ${c.conversions} donations on £${fmt(c.spend)} of advertising, a return of ${c.roas}x against a target of ${input.targetRoas}x. The average gift was £${fmt(c.avgGift)} and each donation cost £${fmt(c.cpa)} to acquire.`,
    `Compared with the previous ${input.days} days, the amount raised is ${direction} ${Math.abs(input.deltasPct.revenue)}% and the cost per donation moved ${input.deltasPct.cpa}%.${input.topCreative ? ` Your strongest ad was "${input.topCreative.name}", a ${input.topCreative.type}, returning ${input.topCreative.roas}x.` : ""}`,
  ];
  const highlights: string[] = [];
  const concerns: string[] = [];
  for (const a of input.adsets) {
    if (a.roas >= input.targetRoas * 1.3 && a.spend >= 100) highlights.push(`${a.name} returned ${a.roas}x on £${fmt(a.spend)}.`);
    else if (a.roas < input.targetRoas * 0.7 && a.spend >= 100) concerns.push(`${a.name} returned ${a.roas}x on £${fmt(a.spend)}, below where we want it.`);
  }
  for (const i of input.insights) {
    if (i.severity === "critical") concerns.unshift(`${i.title}.`);
    else if (i.severity === "positive" && highlights.length < 5) highlights.push(`${i.title}.`);
  }
  if (!highlights.length) highlights.push(`Donations held steady at ${c.conversions} for the period.`);
  const nextSteps = input.actions.length ? input.actions.slice(0, 4) : ["We will keep optimising towards your target and report again next week."];
  return { headline, summary, highlights: highlights.slice(0, 5), concerns: concerns.slice(0, 4), nextSteps };
}

/**
 * Every number in the narrative must appear in the report input (after
 * normalising thousands separators and decimals). Years and percentages that
 * are deltas are allowed when they match too. Anything else is flagged.
 */
export function verifyReportNumbers(narrative: ClientReportNarrative, input: ClientReportInput): NumberCheck {
  const allowed = new Set<string>();
  const add = (n: number | string) => {
    const s = String(n);
    allowed.add(s);
    allowed.add(String(Math.round(Number(s))));
    allowed.add(Number(s).toFixed(1));
    allowed.add(Number(s).toFixed(2));
    allowed.add(Math.abs(Number(s)).toString());
  };
  const figs = [input.current, input.previous];
  for (const f of figs) for (const v of Object.values(f)) add(v);
  for (const v of Object.values(input.deltasPct)) add(v);
  add(input.targetRoas);
  add(input.days);
  for (const a of input.adsets) {
    add(a.spend);
    add(a.revenue);
    add(a.roas);
    add(a.conversions);
  }
  if (input.topCreative) add(input.topCreative.roas);
  for (const i of input.insights) for (const n of numbersIn(`${i.title} ${i.detail}`)) add(n);
  for (const a of input.actions) for (const n of numbersIn(a)) add(n);
  for (const adset of input.adsets) for (const n of numbersIn(adset.name)) add(n);
  if (input.topCreative) for (const n of numbersIn(input.topCreative.name)) add(n);
  add(input.clientName);

  const text = [narrative.headline, ...narrative.summary, ...narrative.highlights, ...narrative.concerns, ...narrative.nextSteps].join(" ");
  const found = numbersIn(text);
  const unverified = found.filter((n) => !allowed.has(n) && !allowed.has(String(Number(n))));
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)], checked: found.length };
}

export function numbersIn(text: string): string[] {
  // ISO dates are references, not figures: strip them so "11" and "8" in 2026-11-08 never count as claims or as allowed numbers.
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  return (withoutDates.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

export function renderClientReport(input: ClientReportInput, narrative: ClientReportNarrative, check: NumberCheck, brand = { primary: "#C8442B", secondary: "#2B3A4A" }): string {
  const money = (n: number) => `£${fmt(n)}`;
  const row = (label: string, now: number, before: number, lowerIsBetter = false, isMoney = true) => {
    const change = before === 0 ? 0 : Math.round(((now - before) / before) * 1000) / 10;
    const good = change === 0 ? "" : (lowerIsBetter ? change < 0 : change > 0) ? "good" : "bad";
    return `<tr><td>${label}</td><td class="num">${isMoney ? money(now) : now}</td><td class="num">${isMoney ? money(before) : before}</td><td class="num ${good}">${change > 0 ? "+" : ""}${change}%</td></tr>`;
  };
  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.clientName)} · weekly update · ${escapeHtml(input.asOf)}</title>
<style>
body{margin:0;font-family:Inter,Arial,sans-serif;color:#1c1c1c;background:#fff}
.wrap{max-width:760px;margin:0 auto;padding:32px 24px}
header{border-bottom:4px solid ${brand.primary};padding-bottom:12px;margin-bottom:20px}
h1{margin:0;font-size:24px;color:${brand.secondary}} .sub{color:#555;font-size:14px}
h2{font-size:16px;margin:24px 0 8px;color:${brand.secondary};text-transform:uppercase;letter-spacing:.5px}
p{line-height:1.55} table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:8px 6px;border-bottom:1px solid #eee;text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums} .good{color:#1b8a4c} .bad{color:#c0392b}
ul{padding-left:20px} li{margin:4px 0} .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.kpi{border:1px solid #eee;border-radius:10px;padding:12px} .kpi b{display:block;font-size:22px;color:${brand.primary}} .kpi span{font-size:12px;color:#555}
footer{margin-top:28px;font-size:12px;color:#777;border-top:1px solid #eee;padding-top:12px}
.verified{display:inline-block;background:#e8f7ee;color:#1b8a4c;border-radius:999px;padding:2px 8px;font-size:12px}
</style></head><body><div class="wrap">
<header><div class="sub">Weekly fundraising update · ${input.days} days to ${escapeHtml(input.asOf)}</div><h1>${escapeHtml(narrative.headline)}</h1></header>
<div class="kpis">
<div class="kpi"><b>${money(input.current.revenue)}</b><span>raised</span></div>
<div class="kpi"><b>${input.current.roas}x</b><span>return (target ${input.targetRoas}x)</span></div>
<div class="kpi"><b>${input.current.conversions}</b><span>donations · ${money(input.current.cpa)} each</span></div>
</div>
${narrative.summary.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
<h2>The numbers</h2>
<table><thead><tr><th></th><th class="num">This period</th><th class="num">Previous</th><th class="num">Change</th></tr></thead><tbody>
${row("Advertising spend", input.current.spend, input.previous.spend, true)}
${row("Raised", input.current.revenue, input.previous.revenue)}
${row("Donations", input.current.conversions, input.previous.conversions, false, false)}
${row("Cost per donation", input.current.cpa, input.previous.cpa, true)}
${row("Average gift", input.current.avgGift, input.previous.avgGift)}
</tbody></table>
<h2>By audience</h2>
<table><thead><tr><th>Audience</th><th class="num">Spend</th><th class="num">Raised</th><th class="num">Return</th><th class="num">Donations</th></tr></thead><tbody>
${input.adsets.map((a) => `<tr><td>${escapeHtml(a.name)}</td><td class="num">${money(a.spend)}</td><td class="num">${money(a.revenue)}</td><td class="num">${a.roas}x</td><td class="num">${a.conversions}</td></tr>`).join("")}
</tbody></table>
${narrative.highlights.length ? `<h2>What went well</h2><ul>${narrative.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : ""}
${narrative.concerns.length ? `<h2>What we are watching</h2><ul>${narrative.concerns.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
<h2>What happens next</h2><ul>${narrative.nextSteps.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
<footer>Prepared by CerealBox from your Meta Ads and donation data. <span class="verified">${check.ok ? `All ${check.checked} figures verified against the data` : `${check.unverified.length} figure(s) need review`}</span></footer>
</div></body></html>`;
}

export function clientReportMarkdown(input: ClientReportInput, narrative: ClientReportNarrative): string {
  return [
    `# ${narrative.headline}`,
    ``,
    `_${input.clientName} · ${input.days} days to ${input.asOf}_`,
    ``,
    ...narrative.summary,
    ``,
    `| | This period | Previous |`,
    `|---|---|---|`,
    `| Raised | £${fmt(input.current.revenue)} | £${fmt(input.previous.revenue)} |`,
    `| Spend | £${fmt(input.current.spend)} | £${fmt(input.previous.spend)} |`,
    `| Return | ${input.current.roas}x | ${input.previous.roas}x |`,
    `| Donations | ${input.current.conversions} | ${input.previous.conversions} |`,
    `| Cost per donation | £${fmt(input.current.cpa)} | £${fmt(input.previous.cpa)} |`,
    ``,
    narrative.highlights.length ? `**What went well**\n${narrative.highlights.map((h) => `- ${h}`).join("\n")}` : "",
    narrative.concerns.length ? `**What we are watching**\n${narrative.concerns.map((c) => `- ${c}`).join("\n")}` : "",
    `**What happens next**\n${narrative.nextSteps.map((n) => `- ${n}`).join("\n")}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

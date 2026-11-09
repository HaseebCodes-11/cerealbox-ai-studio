import type { AdsDataset } from "../../core/ads";
import { escapeHtml } from "../../core/text";
import type { Recommendation } from "../media-buyer/types";
import type { Answer } from "./ask";
import type { Insight, Narrative } from "./insights";
import { aggregate, comparePeriods, dailySeries, lastNDays, previousPeriod, totals } from "./metrics";

/**
 * Self-contained HTML dashboard. In production this is a React/TanStack view
 * inside True ROAS reading the same aggregation functions through Supabase;
 * here it is a single file so anyone can open it with no setup.
 * Chart.js is loaded from cdnjs; the data is inlined as JSON.
 */
export interface DashboardInput {
  data: AdsDataset;
  asOf: string;
  days?: number;
  insights: Insight[];
  narrative: Narrative;
  recommendations?: Recommendation[];
  sampleAnswers?: Answer[];
  generatedBy?: string;
}

/** JSON that is safe inside a <script> block: "<" and ">" are escaped so "</script>" cannot be smuggled in through a name. */
/** SHA-384 of the pinned Chart.js build, so a tampered CDN response is refused by the browser. */
export const CHART_JS_SRI = "sha384-bs/nf9FbdNouRbMiFcrcZfLXYPKiPaGVGplVbv7dLGECccEXDW+S3zjqSKR5ZEaD";

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderDashboard(input: DashboardInput): string {
  const days = input.days ?? 7;
  const period = lastNDays(input.asOf, days);
  const prev = previousPeriod(period);
  const t = totals(input.data, period);
  const p = totals(input.data, prev);
  const clients = comparePeriods(input.data, "client", input.asOf, days);
  const creativeTypes = aggregate(input.data, "creativeType", period);
  const trendPeriod = lastNDays(input.asOf, 28);
  const spendSeries = dailySeries(input.data, "spend", trendPeriod);
  const revenueSeries = dailySeries(input.data, "revenue", trendPeriod);
  const clientMap = new Map(input.data.clients.map((c) => [c.id, c]));

  const delta = (now: number, before: number, lowerIsBetter = false) => {
    if (before === 0) return { text: "—", cls: "flat" };
    const pct = Math.round(((now - before) / before) * 1000) / 10;
    const good = lowerIsBetter ? pct < 0 : pct > 0;
    return { text: `${pct > 0 ? "+" : ""}${pct}% vs prev ${days}d`, cls: pct === 0 ? "flat" : good ? "good" : "bad" };
  };

  const money = (n: number) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  const kpis = [
    { label: "Spend", value: money(t.spend), d: delta(t.spend, p.spend) },
    { label: "Revenue (donations)", value: money(t.revenue), d: delta(t.revenue, p.revenue) },
    { label: "ROAS", value: String(t.roas), d: delta(t.roas, p.roas) },
    { label: "Donations", value: String(t.conversions), d: delta(t.conversions, p.conversions) },
    { label: "CPA", value: money(t.cpa), d: delta(t.cpa, p.cpa, true) },
    { label: "Avg gift", value: money(t.avgGift), d: delta(t.avgGift, p.avgGift) },
  ];

  const sevClass = { critical: "sev-critical", warning: "sev-warning", positive: "sev-positive", info: "sev-info" } as const;

  const chartData = {
    labels: spendSeries.map((s) => s.date.slice(5)),
    spend: spendSeries.map((s) => s.value),
    revenue: revenueSeries.map((s) => s.value),
    clientLabels: clients.map((c) => c.name),
    clientRoas: clients.map((c) => c.recent.roas),
    clientTarget: clients.map((c) => clientMap.get(c.clientId)?.targetRoas ?? 0),
  };

  const recs = input.recommendations ?? [];
  const answers = input.sampleAnswers ?? [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Toast · Meta Ads performance · ${escapeHtml(input.asOf)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="${CHART_JS_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --panel2:#1e2230; --text:#e8eaf0; --muted:#9aa3b5; --accent:#f2b134; --good:#3ddc84; --bad:#ff6b6b; --warn:#f2b134; --info:#5aa9ff; --border:#2a2f3d; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7fb; --panel:#ffffff; --panel2:#f0f2f7; --text:#1c1f26; --muted:#5b6270; --border:#e1e4ec; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family: Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:20px 28px; border-bottom:1px solid var(--border); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  header h1 { margin:0; font-size:22px; letter-spacing:.2px; }
  header .sub { color:var(--muted); font-size:14px; }
  main { padding:24px 28px; display:grid; gap:20px; max-width:1400px; margin:0 auto; }
  .kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:12px; }
  .kpi { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
  .kpi .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.6px; }
  .kpi .value { font-size:26px; font-weight:700; margin:6px 0 2px; }
  .kpi .delta { font-size:12px; } .good { color:var(--good);} .bad { color:var(--bad);} .flat { color:var(--muted);}
  .grid2 { display:grid; grid-template-columns: 2fr 1fr; gap:20px; } @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px; }
  .panel h2 { margin:0 0 12px; font-size:15px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.5px; cursor:pointer; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .sev-critical { background:rgba(255,107,107,.15); color:var(--bad);} .sev-warning { background:rgba(242,177,52,.15); color:var(--warn);} .sev-positive { background:rgba(61,220,132,.15); color:var(--good);} .sev-info { background:rgba(90,169,255,.15); color:var(--info);}
  .insight { padding:10px 0; border-bottom:1px solid var(--border); } .insight:last-child { border-bottom:none; }
  .insight .t { font-weight:600; margin:4px 0; } .insight .d { color:var(--muted); font-size:13px; } .insight .a { font-size:13px; margin-top:4px; }
  .narrative p { line-height:1.5; margin:8px 0; } .narrative h3 { margin:0 0 8px; }
  .ask { display:grid; gap:12px; } .q { font-weight:600; } .a-text { color:var(--text); } .a-src { color:var(--muted); font-size:12px; }
  .risk-human { color:var(--bad); font-weight:600;} .risk-approve { color:var(--warn); font-weight:600;} .risk-auto { color:var(--info); font-weight:600;}
  footer { padding:16px 28px; color:var(--muted); font-size:12px; border-top:1px solid var(--border); }
  canvas { max-height:320px; }
</style>
</head>
<body>
<header>
  <h1>Toast <span class="sub">· Meta Ads performance across ${input.data.clients.length} charity clients</span></h1>
  <span class="sub">Last ${days} days to ${escapeHtml(input.asOf)} · mock data</span>
</header>
<main>
  <section class="kpis">
    ${kpis.map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value">${k.value}</div><div class="delta ${k.d.cls}">${k.d.text}</div></div>`).join("\n    ")}
  </section>

  <section class="grid2">
    <div class="panel">
      <h2>Spend vs revenue · last 28 days</h2>
      <canvas id="trend"></canvas>
    </div>
    <div class="panel narrative">
      <h2>This week in one minute</h2>
      <h3>${escapeHtml(input.narrative.headline)}</h3>
      ${input.narrative.paragraphs.map((pg) => `<p>${escapeHtml(pg)}</p>`).join("\n      ")}
      ${input.narrative.actionsToday.length ? `<p><strong>Actions today</strong></p><ul>${input.narrative.actionsToday.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : ""}
    </div>
  </section>

  <section class="grid2">
    <div class="panel">
      <h2>Clients · last ${days} days vs previous ${days}</h2>
      <table id="clients">
        <thead><tr><th>Client</th><th class="num">Spend</th><th class="num">Revenue</th><th class="num">ROAS</th><th class="num">Target</th><th class="num">ROAS Δ</th><th class="num">Donations</th><th class="num">CPA</th><th class="num">CTR</th></tr></thead>
        <tbody>
        ${clients
          .map((c) => {
            const target = clientMap.get(c.clientId)?.targetRoas ?? 0;
            const cls = c.recent.roas >= target ? "good" : c.recent.roas >= target * 0.7 ? "flat" : "bad";
            const roasDelta = c.hasBaseline ? `<td class="num ${c.deltas.roas >= 0 ? "good" : "bad"}">${c.deltas.roas > 0 ? "+" : ""}${c.deltas.roas}%</td>` : `<td class="num flat" title="No delivery in the previous period">n/a</td>`;
            return `<tr><td>${escapeHtml(c.name)}</td><td class="num">${money(c.recent.spend)}</td><td class="num">${money(c.recent.revenue)}</td><td class="num ${cls}">${c.recent.roas}</td><td class="num">${target}</td>${roasDelta}<td class="num">${c.recent.conversions}</td><td class="num">${money(c.recent.cpa)}</td><td class="num">${c.recent.ctr}%</td></tr>`;
          })
          .join("\n        ")}
        </tbody>
      </table>
    </div>
    <div class="panel">
      <h2>ROAS vs target by client</h2>
      <canvas id="roas"></canvas>
      <h2 style="margin-top:18px">Creative type · last ${days} days</h2>
      <table>
        <thead><tr><th>Type</th><th class="num">Spend</th><th class="num">ROAS</th><th class="num">CPA</th><th class="num">CTR</th></tr></thead>
        <tbody>${creativeTypes.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${money(r.spend)}</td><td class="num">${r.roas}</td><td class="num">${money(r.cpa)}</td><td class="num">${r.ctr}%</td></tr>`).join("")}</tbody>
      </table>
    </div>
  </section>

  <section class="grid2">
    <div class="panel">
      <h2>Insights (${input.insights.length})</h2>
      ${input.insights
        .map(
          (i) => `<div class="insight"><span class="pill ${sevClass[i.severity]}">${i.severity}</span><div class="t">${escapeHtml(i.title)}</div><div class="d">${escapeHtml(i.detail)}</div>${i.suggestedAction ? `<div class="a">→ ${escapeHtml(i.suggestedAction)}</div>` : ""}</div>`,
        )
        .join("\n      ")}
    </div>
    <div class="panel">
      <h2>Ask Toast · example questions</h2>
      <div class="ask">
        ${
          answers.length
            ? answers.map((a) => `<div><div class="q">“${escapeHtml(a.question)}”</div><div class="a-text">${escapeHtml(a.text)}</div><div class="a-src">intent: ${a.intent.intent} · ${a.sources.join(", ")}</div></div>`).join("\n        ")
            : `<div class="a-src">Run <code>npm run toast:ask -- "Which client had the biggest ROAS drop?"</code></div>`
        }
      </div>
    </div>
  </section>

  ${
    recs.length
      ? `<section class="panel">
      <h2>Media Buyer agent · recommendations for ${escapeHtml(input.asOf)}</h2>
      <table>
        <thead><tr><th>Risk</th><th>Client</th><th>Entity</th><th>Recommendation</th><th>Proposed change</th><th class="num">Confidence</th><th>Status</th></tr></thead>
        <tbody>${recs
          .map(
            (r) =>
              `<tr><td class="risk-${r.risk}">${r.risk}</td><td>${escapeHtml(clientMap.get(r.entity.clientId)?.name ?? r.entity.clientId)}</td><td>${r.entity.level}: ${escapeHtml(r.entity.name)}</td><td title="${escapeHtml(r.rationale)}">${escapeHtml(r.title)}</td><td>${r.proposedChange ? `${r.proposedChange.field}: ${r.proposedChange.from} → ${r.proposedChange.to}` : "—"}</td><td class="num">${Math.round(r.confidence * 100)}%</td><td>${r.status}</td></tr>`,
          )
          .join("")}</tbody>
      </table>
    </section>`
      : ""
  }
</main>
<footer>Generated ${escapeHtml(input.generatedBy ?? "cerealbox-ai-studio")} · data range ${escapeHtml(input.data.range.start)} → ${escapeHtml(input.data.range.end)} · all figures from the aggregation layer; the narrative is written by the LLM from those figures only.</footer>
<script id="toast-data" type="application/json">${jsonForScript(chartData)}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('toast-data').textContent);
  if (typeof Chart === 'undefined') return; // offline: tables still work
  var muted = getComputedStyle(document.documentElement).getPropertyValue('--muted');
  new Chart(document.getElementById('trend'), { type:'line', data:{ labels:data.labels, datasets:[
    { label:'Spend £', data:data.spend, borderColor:'#5aa9ff', backgroundColor:'rgba(90,169,255,.15)', tension:.3, fill:true },
    { label:'Revenue £', data:data.revenue, borderColor:'#3ddc84', backgroundColor:'rgba(61,220,132,.12)', tension:.3, fill:true } ] },
    options:{ responsive:true, plugins:{ legend:{ labels:{ color:muted } } }, scales:{ x:{ ticks:{ color:muted, maxTicksLimit:10 } }, y:{ ticks:{ color:muted } } } } });
  new Chart(document.getElementById('roas'), { type:'bar', data:{ labels:data.clientLabels, datasets:[
    { label:'ROAS', data:data.clientRoas, backgroundColor:'#f2b134' },
    { label:'Target', data:data.clientTarget, backgroundColor:'rgba(154,163,181,.35)' } ] },
    options:{ responsive:true, plugins:{ legend:{ labels:{ color:muted } } }, scales:{ x:{ ticks:{ color:muted } }, y:{ ticks:{ color:muted }, beginAtZero:true } } } });
  // Sortable client table
  var table = document.getElementById('clients');
  table.querySelectorAll('th').forEach(function(th, idx){ th.addEventListener('click', function(){
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    var asc = th.dataset.asc === '1'; th.dataset.asc = asc ? '0' : '1';
    rows.sort(function(a,b){ var x=a.cells[idx].textContent.replace(/[£,%+]/g,''), y=b.cells[idx].textContent.replace(/[£,%+]/g,''); var nx=parseFloat(x), ny=parseFloat(y); if(!isNaN(nx)&&!isNaN(ny)) return asc?nx-ny:ny-nx; return asc?x.localeCompare(y):y.localeCompare(x); });
    rows.forEach(function(r){ table.tBodies[0].appendChild(r); });
  }); });
})();
</script>
</body>
</html>`;
}

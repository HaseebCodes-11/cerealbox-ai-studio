import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdsDataset } from "@src/core/ads";
import { aggregate, comparePeriods, dailySeries, lastNDays, previousPeriod, totals } from "@src/areas/toast/metrics";
import { answerIntent, parseIntentHeuristically, type Answer } from "@src/areas/toast/ask";
import type { ToastBundle } from "../lib/data";
import { money, pct } from "../lib/data";
import { Badge, Card, Empty, Kpi } from "../components/ui";

export function ToastView({ data, bundle }: { data: AdsDataset; bundle: ToastBundle }) {
  const days = bundle.days;
  const asOf = bundle.asOf;
  const period = lastNDays(asOf, days);
  const prev = previousPeriod(period);
  const t = totals(data, period);
  const p = totals(data, prev);
  const clients = useMemo(() => comparePeriods(data, "client", asOf, days), [data, asOf, days]);
  const creativeTypes = useMemo(() => aggregate(data, "creativeType", period), [data, period.start, period.end]);
  const trend = useMemo(() => {
    const long = lastNDays(asOf, 28);
    const spend = dailySeries(data, "spend", long);
    const revenue = dailySeries(data, "revenue", long);
    return spend.map((s, i) => ({ date: s.date.slice(5), spend: Math.round(s.value), revenue: Math.round(revenue[i]?.value ?? 0) }));
  }, [data, asOf]);
  const clientMap = new Map(data.clients.map((c) => [c.id, c]));
  const roasBars = clients.map((c) => ({ name: c.name, roas: c.recent.roas, target: clientMap.get(c.clientId)?.targetRoas ?? 0 }));

  const delta = (now: number, before: number, lowerIsBetter = false) => {
    if (before === 0) return { text: "—", good: null };
    const change = Math.round(((now - before) / before) * 1000) / 10;
    return { text: `${pct(change)} vs prev ${days}d`, good: change === 0 ? null : lowerIsBetter ? change < 0 : change > 0 };
  };

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Spend" value={money(t.spend)} {...delta(t.spend, p.spend)} delta={delta(t.spend, p.spend).text} />
        <Kpi label="Revenue" value={money(t.revenue)} good={delta(t.revenue, p.revenue).good} delta={delta(t.revenue, p.revenue).text} />
        <Kpi label="ROAS" value={String(t.roas)} good={delta(t.roas, p.roas).good} delta={delta(t.roas, p.roas).text} />
        <Kpi label="Donations" value={String(t.conversions)} good={delta(t.conversions, p.conversions).good} delta={delta(t.conversions, p.conversions).text} />
        <Kpi label="CPA" value={money(t.cpa)} good={delta(t.cpa, p.cpa, true).good} delta={delta(t.cpa, p.cpa, true).text} />
        <Kpi label="Avg gift" value={money(t.avgGift)} good={delta(t.avgGift, p.avgGift).good} delta={delta(t.avgGift, p.avgGift).text} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Spend vs revenue · last 28 days" className="lg:col-span-2">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "var(--panel2)", border: "1px solid var(--border)" }} />
                <Legend />
                <Line type="monotone" dataKey="spend" name="Spend £" stroke="var(--info)" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="revenue" name="Revenue £" stroke="var(--good)" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="This week in one minute">
          <h3 className="mb-2 text-lg font-semibold">{bundle.narrative.headline}</h3>
          {bundle.narrative.paragraphs.map((para, i) => (
            <p key={i} className="mb-2 text-sm leading-relaxed text-[var(--text)]/90">
              {para}
            </p>
          ))}
          {bundle.narrative.actionsToday.length > 0 && (
            <>
              <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Actions today</div>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {bundle.narrative.actionsToday.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={`Clients · last ${days} days vs previous ${days}`} className="lg:col-span-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-[var(--muted)]">
              <tr>
                <th className="py-2 text-left">Client</th>
                <th className="num">Spend</th>
                <th className="num">Revenue</th>
                <th className="num">ROAS</th>
                <th className="num">Target</th>
                <th className="num">ROAS Δ</th>
                <th className="num">Donations</th>
                <th className="num">CPA</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => {
                const target = clientMap.get(c.clientId)?.targetRoas ?? 0;
                const cls = c.recent.roas >= target ? "text-emerald-400" : c.recent.roas >= target * 0.7 ? "" : "text-red-400";
                return (
                  <tr key={c.key} className="border-t border-[var(--border)]">
                    <td className="py-2">{c.name}</td>
                    <td className="num">{money(c.recent.spend)}</td>
                    <td className="num">{money(c.recent.revenue)}</td>
                    <td className={`num ${cls}`}>{c.recent.roas}</td>
                    <td className="num">{target}</td>
                    {c.hasBaseline ? <td className={`num ${c.deltas.roas >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(c.deltas.roas)}</td> : <td className="num text-[var(--muted)]" title="No delivery in the previous period">n/a</td>}
                    <td className="num">{c.recent.conversions}</td>
                    <td className="num">{money(c.recent.cpa)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <Card title="ROAS vs target">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={roasBars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="var(--muted)" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "var(--panel2)", border: "1px solid var(--border)" }} />
                <Bar dataKey="roas" name="ROAS" fill="var(--accent)" />
                <Bar dataKey="target" name="Target" fill="rgba(154,163,181,0.35)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-[var(--muted)]">
              <tr>
                <th className="text-left">Type</th>
                <th className="num">Spend</th>
                <th className="num">ROAS</th>
                <th className="num">CPA</th>
              </tr>
            </thead>
            <tbody>
              {creativeTypes.map((r) => (
                <tr key={r.key} className="border-t border-[var(--border)]">
                  <td className="py-1">{r.name}</td>
                  <td className="num">{money(r.spend)}</td>
                  <td className="num">{r.roas}</td>
                  <td className="num">{money(r.cpa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={`Insights (${bundle.insights.length})`}>
          <ul className="divide-y divide-[var(--border)]">
            {bundle.insights.map((i) => (
              <li key={i.id} className="py-3">
                <Badge tone={i.severity}>{i.severity}</Badge>
                <div className="mt-1 font-semibold">{i.title}</div>
                <div className="text-sm text-[var(--muted)]">{i.detail}</div>
                {i.suggestedAction && <div className="mt-1 text-sm">→ {i.suggestedAction}</div>}
              </li>
            ))}
          </ul>
        </Card>
        <AskToast data={data} asOf={asOf} seed={bundle.answers} />
      </div>
    </div>
  );
}

export function AskToast({ data, asOf, seed }: { data: AdsDataset; asOf: string; seed: Answer[] }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Answer[]>(seed);
  const ask = (q: string) => {
    const text = q.trim();
    if (!text) return;
    // In production the intent comes from Claude (toast.intent); the heuristic parser is the offline fallback.
    const intent = parseIntentHeuristically(text, data.clients.map((c) => c.name));
    setAnswers((prev) => [answerIntent(text, intent, data, asOf), ...prev].slice(0, 8));
    setQuestion("");
  };
  return (
    <Card title="Ask Toast">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input aria-label="Ask Toast a question" className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="Which client had the biggest ROAS drop last week?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button type="submit" className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-black">
          Ask
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {["Which client had the biggest ROAS drop last week?", "Do video or static creatives perform better?", "Anything unusual this week?", "Which clients have the worst CPA?"].map((q) => (
          <button key={q} type="button" className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]" onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-3">
        {answers.length === 0 && <Empty>Ask anything about ROAS, CPA, spend, revenue or donations by client.</Empty>}
        {answers.map((a, i) => (
          <div key={`${a.question}-${i}`} className="rounded-md bg-[var(--panel2)] p-3">
            <div className="text-sm font-semibold">“{a.question}”</div>
            <div className="mt-1 text-sm" data-testid="answer-text">
              {a.text}
            </div>
            {a.table && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-[var(--muted)]">
                  <tr>
                    {a.table.columns.map((c) => (
                      <th key={c} className="py-1 text-left">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {a.table.rows.map((row, ri) => (
                    <tr key={ri} className="border-t border-[var(--border)]">
                      {row.map((cell, ci) => (
                        <td key={ci} className="py-1">
                          {String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-1 text-xs text-[var(--muted)]">
              intent: {a.intent.intent} · {a.sources.join(", ")}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

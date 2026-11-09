import { useEffect, useMemo, useState } from "react";
import type { AgentRun } from "../lib/data";
import { readDecisions, writeDecision, type LocalDecision } from "../lib/data";
import { Badge, Button, Card, Empty } from "../components/ui";

const LADDER = [
  { level: "assist", text: "Every finding is a recommendation; humans do everything. Default for every new client." },
  { level: "copilot", text: "Notifications run automatically; budget moves and pauses are one-click approvals in Slack or here." },
  { level: "autopilot", text: "Budget moves ≤ 20% inside caps and single-ad pauses execute automatically; ad-set pauses and tracking issues still wait for a human." },
];

export function AgentView({ run }: { run: AgentRun }) {
  const [risk, setRisk] = useState<"all" | "human" | "approve" | "auto">("all");
  const [decisions, setDecisions] = useState<Record<string, LocalDecision>>({});
  useEffect(() => setDecisions(readDecisions()), []);
  const recs = useMemo(() => run.recommendations.filter((r) => risk === "all" || r.risk === risk), [run.recommendations, risk]);
  const approve = (id: string) => setDecisions(writeDecision(`rec:${id}`, { status: "approved", at: new Date().toISOString() }));
  const reject = (id: string) => setDecisions(writeDecision(`rec:${id}`, { status: "rejected", at: new Date().toISOString() }));

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={`Autonomy · running as ${run.autonomy}${run.dryRun ? " (dry run)" : ""}`} className="lg:col-span-2">
          <ol className="grid gap-2 md:grid-cols-3">
            {LADDER.map((l) => (
              <li key={l.level} className={`rounded-md border p-3 text-sm ${l.level === run.autonomy ? "border-[var(--accent)] bg-[var(--panel2)]" : "border-[var(--border)]"}`}>
                <div className="font-semibold capitalize">{l.level}</div>
                <div className="mt-1 text-xs text-[var(--muted)]">{l.text}</div>
              </li>
            ))}
          </ol>
        </Card>
        <Card title={`Alerts (${run.alerts.length})`}>
          {run.alerts.length === 0 ? (
            <Empty>No alerts.</Empty>
          ) : (
            <ul className="grid gap-2 text-sm">
              {run.alerts.map((a) => (
                <li key={a.id} className="rounded-md bg-[var(--panel2)] p-2">
                  <Badge tone={a.severity === "critical" ? "critical" : a.severity === "warning" ? "warning" : "info"}>{a.severity}</Badge> <span className="font-semibold">{a.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title={`Recommendations for ${run.asOf} (${recs.length})`}
        action={
          <div className="flex gap-1">
            {(["all", "human", "approve", "auto"] as const).map((r) => (
              <button key={r} type="button" aria-pressed={risk === r} className={`rounded-full px-2.5 py-1 text-xs ${risk === r ? "bg-[var(--accent)] text-black" : "border border-[var(--border)] text-[var(--muted)]"}`} onClick={() => setRisk(r)}>
                {r}
              </button>
            ))}
          </div>
        }
      >
        {recs.length === 0 ? (
          <Empty>No recommendations at this risk tier.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="py-2 text-left">Risk</th>
                  <th className="text-left">Entity</th>
                  <th className="text-left">Recommendation</th>
                  <th className="text-left">Change</th>
                  <th className="num">Conf.</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Decision</th>
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => {
                  const local = decisions[`rec:${r.id}`];
                  return (
                    <tr key={r.id} className="border-t border-[var(--border)] align-top">
                      <td className="py-2">
                        <Badge tone={r.risk}>{r.risk}</Badge>
                      </td>
                      <td>
                        <div className="text-xs text-[var(--muted)]">{r.entity.level}</div>
                        {r.entity.name}
                      </td>
                      <td>
                        <div className="font-semibold">{r.title}</div>
                        <div className="max-w-md text-xs text-[var(--muted)]">{r.rationale}</div>
                      </td>
                      <td className="whitespace-nowrap">{r.proposedChange ? `${r.proposedChange.field}: ${r.proposedChange.from} → ${r.proposedChange.to}` : "—"}</td>
                      <td className="num">{Math.round(r.confidence * 100)}%</td>
                      <td>
                        <Badge tone={r.status}>{r.status}</Badge>
                      </td>
                      <td>
                        {local ? (
                          <Badge tone={local.status}>{local.status}</Badge>
                        ) : r.proposedChange ? (
                          <div className="flex gap-1">
                            <Button onClick={() => approve(r.id)} aria-label={`Approve ${r.id}`}>
                              Approve
                            </Button>
                            <Button variant="ghost" onClick={() => reject(r.id)} aria-label={`Reject ${r.id}`}>
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">investigate</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Morning briefs">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {run.briefs.map((b) => (
            <div key={b.clientId} className="rounded-md bg-[var(--panel2)] p-3 text-sm">
              <div className="font-semibold">{b.clientName}</div>
              <div className="mt-1">{b.brief.headline}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">{b.brief.summary}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

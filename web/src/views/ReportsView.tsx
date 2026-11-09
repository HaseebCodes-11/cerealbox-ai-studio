import { useEffect, useState } from "react";
import type { CommsDraftRecord, ReportsIndex } from "../lib/data";
import { readDecisions, writeDecision, type LocalDecision } from "../lib/data";
import { Badge, Button, Card, Empty } from "../components/ui";

/**
 * Client-facing outputs: the weekly report per client (every figure verified
 * against the data) and drafted replies to client emails, each with its risk
 * tier. "Approve" here means a human has read it and it may be sent; nothing
 * sends itself.
 */
export function ReportsView({ index, drafts }: { index: ReportsIndex; drafts: CommsDraftRecord[] }) {
  const [clientId, setClientId] = useState(index.reports[0]?.clientId ?? "");
  const [decisions, setDecisions] = useState<Record<string, LocalDecision>>({});
  useEffect(() => setDecisions(readDecisions()), []);
  const report = index.reports.find((r) => r.clientId === clientId) ?? index.reports[0];
  const decide = (id: string, status: LocalDecision["status"]) => setDecisions(writeDecision(`comms:${id}`, { status, at: new Date().toISOString() }));

  return (
    <div className="grid gap-5">
      <Card
        title={`Weekly client reports · week to ${index.asOf}`}
        action={
          <select aria-label="Client report" className="rounded-md border border-[var(--border)] bg-[var(--panel2)] px-2 py-1 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {index.reports.map((r) => (
              <option key={r.clientId} value={r.clientId}>
                {r.clientName}
              </option>
            ))}
          </select>
        }
      >
        {!report ? (
          <Empty>No reports yet. Run `npm run reports`.</Empty>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
            <ul className="grid gap-2">
              {index.reports.map((r) => (
                <li key={r.clientId}>
                  <button type="button" className={`w-full rounded-md border p-3 text-left text-sm ${r.clientId === report.clientId ? "border-[var(--accent)] bg-[var(--panel2)]" : "border-[var(--border)] hover:bg-white/5"}`} onClick={() => setClientId(r.clientId)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{r.clientName}</span>
                      <Badge tone={r.verified ? "approved" : "warning"}>{r.verified ? "figures verified" : "needs review"}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">{r.headline}</div>
                  </button>
                </li>
              ))}
            </ul>
            <iframe title={`Report for ${report.clientName}`} src={`/${report.html}`} sandbox="allow-same-origin" className="h-[640px] w-full rounded border border-[var(--border)] bg-white" />
          </div>
        )}
      </Card>

      <Card title={`Client emails · drafted replies (${drafts.length})`}>
        {drafts.length === 0 ? (
          <Empty>No drafts. Run `npm run reports`.</Empty>
        ) : (
          <div className="grid gap-3">
            {drafts.map((d) => {
              const local = decisions[`comms:${d.question.id}`];
              return (
                <div key={d.question.id} className="rounded-md bg-[var(--panel2)] p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold">{d.question.from}</span> <span className="text-xs text-[var(--muted)]">· {d.question.clientId} · {d.question.receivedAt}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={d.risk}>{d.risk === "approve" ? "ready to send" : "needs a human"}</Badge>
                      <Badge tone={d.numbers.ok ? "approved" : "rejected"}>{d.numbers.ok ? "numbers verified" : "unverified number"}</Badge>
                      <span className="text-xs text-[var(--muted)]">{d.reply.category}</span>
                    </div>
                  </div>
                  <blockquote className="mt-2 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]">{d.question.text}</blockquote>
                  <pre className="mt-2 whitespace-pre-wrap rounded bg-black/30 p-3 font-sans text-sm" data-testid={`draft-${d.question.id}`}>
                    {d.reply.reply}
                  </pre>
                  {d.reply.escalationReason && <div className="mt-2 text-xs text-amber-300">Escalation: {d.reply.escalationReason}</div>}
                  <div className="mt-2 flex items-center gap-2">
                    {local ? (
                      <Badge tone={local.status}>{local.status === "approved" ? "approved to send" : "rejected"}</Badge>
                    ) : d.risk === "approve" ? (
                      <>
                        <Button onClick={() => decide(d.question.id, "approved")} aria-label={`Approve ${d.question.id}`}>
                          Approve to send
                        </Button>
                        <Button variant="ghost" onClick={() => decide(d.question.id, "rejected")} aria-label={`Reject ${d.question.id}`}>
                          Rewrite myself
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">Holding reply only; the account manager answers this one.</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

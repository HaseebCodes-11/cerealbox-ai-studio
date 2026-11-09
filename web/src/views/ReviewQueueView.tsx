import { useEffect, useMemo, useState } from "react";
import type { ReviewItem, ReviewQueue } from "../lib/data";
import { readDecisions, writeDecision, type LocalDecision } from "../lib/data";
import { Badge, Button, Card, Empty } from "../components/ui";

/**
 * The human gate. Every pipeline stage lands here with its guardrail score and
 * a preview of the artefact; approving opens the next stage, rejecting sends
 * it back with a reason. Decisions are kept in localStorage for the demo; in
 * production they are rows in review_gates and the approve button calls the
 * run-pipeline-stage Edge Function.
 */
export function ReviewQueueView({ queue, dir }: { queue: ReviewQueue; dir: string }) {
  const [decisions, setDecisions] = useState<Record<string, LocalDecision>>({});
  const [selected, setSelected] = useState<string | null>(queue.items[0]?.id ?? null);
  const [note, setNote] = useState("");
  useEffect(() => setDecisions(readDecisions()), []);

  const items = useMemo(() => queue.items.map((it) => ({ ...it, local: decisions[it.id] })), [queue.items, decisions]);
  const current = items.find((i) => i.id === selected) ?? items[0];
  const decide = (id: string, status: LocalDecision["status"]) => {
    setDecisions(writeDecision(id, { status, at: new Date().toISOString(), ...(note ? { note } : {}) }));
    setNote("");
  };
  const reset = (id: string) => setDecisions(writeDecision(id, null));
  const pending = items.filter((i) => !i.local).length;

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <Card title={`Gates · ${pending} awaiting you`}>
        <ul className="grid gap-2">
          {items.map((it) => {
            const status = it.local?.status ?? "pending";
            return (
              <li key={it.id}>
                <button type="button" className={`w-full rounded-md border p-3 text-left text-sm ${current?.id === it.id ? "border-[var(--accent)] bg-[var(--panel2)]" : "border-[var(--border)] hover:bg-white/5"}`} onClick={() => setSelected(it.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{it.gate}</span>
                    <Badge tone={status}>{status}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {it.area} · risk <span className={it.risk === "human" ? "text-red-300" : it.risk === "approve" ? "text-amber-300" : "text-sky-300"}>{it.risk}</span> · guardrails {it.guardrailScore}/100
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {queue.quality && (
          <div className="mt-4 rounded-md bg-[var(--panel2)] p-3 text-sm">
            <div className="text-xs uppercase tracking-wider text-[var(--muted)]">Judge</div>
            <div className="mt-1">
              Mean {queue.quality.meanOverall}/10 · <Badge tone="ship">{queue.quality.verdictCounts["ship"] ?? 0} ship</Badge> <Badge tone="revise">{queue.quality.verdictCounts["revise"] ?? 0} revise</Badge>{" "}
              <Badge tone="reject">{queue.quality.verdictCounts["reject"] ?? 0} reject</Badge>
            </div>
          </div>
        )}
        {queue.cost && (
          <div className="mt-2 text-xs text-[var(--muted)]">
            <div>
              {queue.cost.llmCalls} model calls · ${queue.cost.costUsd.toFixed(2)} estimated
            </div>
            {queue.cost.byArea && (
              <ul className="mt-1 grid grid-cols-2 gap-x-3" data-testid="cost-by-area">
                {Object.entries(queue.cost.byArea)
                  .sort((a, b) => b[1] - a[1])
                  .map(([area, usd]) => (
                    <li key={area} className="flex justify-between">
                      <span>{area}</span>
                      <span className="num">${usd.toFixed(3)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card
        title={current ? `${current.gate} · ${current.area}` : "Select a gate"}
        action={
          current && (
            <div className="flex items-center gap-2">
              {current.local ? (
                <>
                  <Badge tone={current.local.status}>{current.local.status}</Badge>
                  <Button variant="ghost" onClick={() => reset(current.id)}>
                    Undo
                  </Button>
                </>
              ) : (
                <>
                  <input aria-label="Decision note" className="w-48 rounded-md border border-[var(--border)] bg-[var(--panel2)] px-2 py-1 text-xs" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button variant="danger" onClick={() => decide(current.id, "rejected")}>
                    Reject
                  </Button>
                  <Button onClick={() => decide(current.id, "approved")}>Approve</Button>
                </>
              )}
            </div>
          )
        }
      >
        {!current ? <Empty>Nothing to review.</Empty> : <Preview item={current} dir={dir} />}
      </Card>
    </div>
  );
}

function Preview({ item, dir }: { item: ReviewItem; dir: string }) {
  const kind = item.preview?.kind;
  const raw = item.preview?.data;
  // Data files can be stale or half-written; render what we can and say so instead of crashing the queue.
  const data: unknown = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? raw : kind === "copy" || kind === "ugc" ? {} : [];
  const missing = raw === null || raw === undefined;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-[var(--muted)]">{item.summary}</p>
      {missing && <Empty>No preview data was saved for this gate.</Empty>}
      {kind === "ideas" && (
        <ul className="grid gap-2">
          {(data as Array<{ rank: number; title: string; angle: string; hook: string; total: number; whyItWorks: string }>).map((i) => (
            <li key={i.title} className="rounded-md bg-[var(--panel2)] p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold">
                  #{i.rank} {i.title}
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {i.angle} · {i.total}
                </span>
              </div>
              <div className="mt-1 italic">“{i.hook}”</div>
              <div className="mt-1 text-xs text-[var(--muted)]">{i.whyItWorks}</div>
            </li>
          ))}
        </ul>
      )}
      {kind === "copy" && (
        <div className="grid gap-3 text-sm md:grid-cols-2">
          {(["hooks", "headlines", "descriptions", "storyOverlays"] as const).map((field) => (
            <div key={field} className="rounded-md bg-[var(--panel2)] p-3">
              <div className="text-xs uppercase tracking-wider text-[var(--muted)]">{field}</div>
              <ul className="mt-1 list-disc pl-4">
                {((data as Record<string, string[]>)[field] ?? []).map((v) => (
                  <li key={v}>
                    {v} <span className="text-xs text-[var(--muted)]">({v.length})</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="rounded-md bg-[var(--panel2)] p-3 md:col-span-2">
            <div className="text-xs uppercase tracking-wider text-[var(--muted)]">primary text</div>
            {((data as { primaryTexts: Array<{ variant: string; text: string }> }).primaryTexts ?? []).map((p) => (
              <p key={p.variant} className="mt-2 whitespace-pre-line">
                <span className="mr-2 rounded bg-black/30 px-1.5 py-0.5 text-xs">{p.variant}</span>
                {p.text}
              </p>
            ))}
          </div>
        </div>
      )}
      {kind === "creatives" && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(data as Array<{ id: string; format: string; layout: string; png: string; score: number; ok: boolean; issues: string[] }>).map((c) => (
            <figure key={c.id} className="rounded-md bg-[var(--panel2)] p-2 text-xs">
              <img src={`/${dir}/${c.png}`} alt={`${c.format} ${c.layout}`} className="w-full rounded" />
              <figcaption className="mt-2 flex items-center justify-between">
                <span>
                  {c.format} · {c.layout}
                </span>
                <Badge tone={c.ok ? "approved" : "rejected"}>{c.score}</Badge>
              </figcaption>
              {c.issues.length > 0 && <div className="mt-1 text-[var(--muted)]">{c.issues.join("; ")}</div>}
            </figure>
          ))}
        </div>
      )}
      {kind === "scripts" && (
        <div className="grid gap-3">
          {(data as Array<{ title: string; style: string; targetSeconds: number; ok: boolean; score: number; beats: Array<{ name: string; seconds: number; voiceover: string; onScreenText: string }> }>).map((s) => (
            <div key={s.title} className="rounded-md bg-[var(--panel2)] p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{s.title}</span>
                <Badge tone={s.ok ? "approved" : "rejected"}>QA {s.score}</Badge>
              </div>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {s.beats.map((b) => (
                    <tr key={b.name} className="border-t border-[var(--border)] align-top">
                      <td className="py-1 pr-2 font-semibold">{b.name}</td>
                      <td className="py-1 pr-2 text-[var(--muted)]">{b.seconds}s</td>
                      <td className="py-1 pr-2">{b.voiceover}</td>
                      <td className="py-1 text-[var(--muted)]">{b.onScreenText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      {kind === "ugc" && (
        <div className="grid gap-2 text-sm">
          {Object.entries(data as Record<string, string | number | boolean>).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-[var(--border)] py-1">
              <span className="text-[var(--muted)]">{k}</span>
              <span className="text-right">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
      {kind === "landing" && (
        <div className="grid gap-3 lg:grid-cols-2">
          {(data as Array<{ variant: string; html: string; headline: string; hypothesis: string; ok: boolean; score: number }>).map((l) => (
            <div key={l.variant} className="rounded-md bg-[var(--panel2)] p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Variant {l.variant}</span>
                <Badge tone={l.ok ? "approved" : "rejected"}>QA {l.score}</Badge>
              </div>
              <div className="mt-1">{l.headline}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">{l.hypothesis}</div>
              <iframe title={`Landing variant ${l.variant}`} src={`/${dir}/${l.html}`} className="mt-2 h-72 w-full rounded border border-[var(--border)] bg-white" />
            </div>
          ))}
        </div>
      )}
      {kind === "launch" && (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-[var(--muted)]">
            <tr>
              <th className="text-left">Ad set</th>
              <th className="text-left">Placement</th>
              <th className="num">£/day</th>
              <th className="num">Ads</th>
            </tr>
          </thead>
          <tbody>
            {(data as Array<{ name: string; placement: string; dailyBudgetGbp: number; ads: number }>).map((a) => (
              <tr key={a.name} className="border-t border-[var(--border)]">
                <td className="py-1">{a.name}</td>
                <td>{a.placement}</td>
                <td className="num">{a.dailyBudgetGbp}</td>
                <td className="num">{a.ads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

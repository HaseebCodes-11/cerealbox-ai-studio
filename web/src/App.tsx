import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadAgentRun, loadDataset, loadManifest, loadReviewQueue, loadToastBundle } from "./lib/data";
import { ToastView } from "./views/ToastView";
import { ReviewQueueView } from "./views/ReviewQueueView";
import { AgentView } from "./views/AgentView";
import { Empty } from "./components/ui";

type Tab = "toast" | "review" | "agent";

export function App() {
  const [tab, setTab] = useState<Tab>("toast");
  const manifest = useQuery({ queryKey: ["manifest"], queryFn: loadManifest });
  const [briefDir, setBriefDir] = useState<string | null>(null);
  const dir = briefDir ?? manifest.data?.briefs[0]?.dir ?? null;

  return (
    <div className="min-h-full">
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold">
              True ROAS <span className="font-normal text-[var(--muted)]">· AI Studio</span>
            </h1>
            <div className="text-xs text-[var(--muted)]">{manifest.data ? `Generated ${manifest.data.generatedAt.slice(0, 16).replace("T", " ")} · provider ${manifest.data.provider} · mock data` : "Loading…"}</div>
          </div>
          <nav className="flex gap-1" aria-label="Sections">
            {(["toast", "review", "agent"] as Tab[]).map((t) => (
              <button key={t} type="button" aria-current={tab === t ? "page" : undefined} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab === t ? "bg-[var(--accent)] text-black" : "text-[var(--muted)] hover:text-[var(--text)]"}`} onClick={() => setTab(t)}>
                {t === "toast" ? "Toast" : t === "review" ? "Review queue" : "Ads agent"}
              </button>
            ))}
          </nav>
          {manifest.data && manifest.data.briefs.length > 1 && tab === "review" && (
            <select aria-label="Brief" className="rounded-md border border-[var(--border)] bg-[var(--panel2)] px-2 py-1 text-sm" value={dir ?? ""} onChange={(e) => setBriefDir(e.target.value)}>
              {manifest.data.briefs.map((b) => (
                <option key={b.id} value={b.dir}>
                  {b.client} · {b.campaign}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        {manifest.isError && <Empty>Could not load /manifest.json. Run `npm run demo` first so the app has data to show.</Empty>}
        {tab === "toast" && <ToastTab />}
        {tab === "review" && dir && <ReviewTab dir={dir} />}
        {tab === "agent" && <AgentTab />}
      </main>
    </div>
  );
}

function ToastTab() {
  const data = useQuery({ queryKey: ["dataset"], queryFn: loadDataset });
  const bundle = useQuery({ queryKey: ["toast"], queryFn: loadToastBundle });
  if (data.isLoading || bundle.isLoading) return <Empty>Loading Toast…</Empty>;
  if (!data.data || !bundle.data) return <Empty>Toast data not found. Run `npm run demo`.</Empty>;
  return <ToastView data={data.data} bundle={bundle.data} />;
}

function ReviewTab({ dir }: { dir: string }) {
  const queue = useQuery({ queryKey: ["queue", dir], queryFn: () => loadReviewQueue(dir) });
  if (queue.isLoading) return <Empty>Loading review queue…</Empty>;
  if (!queue.data) return <Empty>No review queue for this brief.</Empty>;
  return <ReviewQueueView queue={queue.data} dir={dir} />;
}

function AgentTab() {
  const run = useQuery({ queryKey: ["agent"], queryFn: loadAgentRun });
  if (run.isLoading) return <Empty>Loading agent run…</Empty>;
  if (!run.data) return <Empty>No agent run found. Run `npm run demo`.</Empty>;
  return <AgentView run={run.data} />;
}

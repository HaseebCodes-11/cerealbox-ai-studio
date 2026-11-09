import type { ReactNode } from "react";

/** Small shadcn-style primitives, hand-rolled so the demo has no generator step. */

export function Card({ title, children, className = "", action }: { title?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES: Record<string, string> = {
  critical: "bg-red-500/15 text-red-300",
  warning: "bg-amber-400/15 text-amber-300",
  positive: "bg-emerald-400/15 text-emerald-300",
  info: "bg-sky-400/15 text-sky-300",
  human: "bg-red-500/15 text-red-300",
  approve: "bg-amber-400/15 text-amber-300",
  auto: "bg-sky-400/15 text-sky-300",
  approved: "bg-emerald-400/15 text-emerald-300",
  rejected: "bg-red-500/15 text-red-300",
  pending: "bg-zinc-500/20 text-zinc-300",
  proposed: "bg-zinc-500/20 text-zinc-300",
  executed: "bg-emerald-400/15 text-emerald-300",
  auto_executed: "bg-emerald-400/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
  ship: "bg-emerald-400/15 text-emerald-300",
  revise: "bg-amber-400/15 text-amber-300",
  reject: "bg-red-500/15 text-red-300",
};

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone] ?? "bg-zinc-500/20 text-zinc-300"}`}>{children}</span>;
}

export function Button({ children, onClick, variant = "primary", disabled, type = "button", "aria-label": ariaLabel }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; type?: "button" | "submit"; "aria-label"?: string }) {
  const base = "rounded-md px-3 py-1.5 text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed";
  const styles = variant === "primary" ? "bg-[var(--accent)] text-black hover:brightness-110" : variant === "danger" ? "bg-red-500/20 text-red-200 hover:bg-red-500/30" : "border border-[var(--border)] text-[var(--text)] hover:bg-white/5";
  return (
    <button type={type} className={`${base} ${styles}`} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Kpi({ label, value, delta, good }: { label: string; value: string; delta?: string; good?: boolean | null }) {
  const cls = good === null || good === undefined ? "text-[var(--muted)]" : good ? "text-emerald-400" : "text-red-400";
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {delta && <div className={`text-xs ${cls}`}>{delta}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">{children}</div>;
}

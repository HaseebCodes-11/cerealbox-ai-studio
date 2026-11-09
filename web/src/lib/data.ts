import type { AdsDataset } from "@src/core/ads";
import type { Recommendation, Alert } from "@src/areas/media-buyer/types";
import type { DailyBrief } from "@src/areas/media-buyer/agent";
import type { Insight, Narrative } from "@src/areas/toast/insights";
import type { Answer } from "@src/areas/toast/ask";
import type { GateRecord } from "@src/orchestrator/pipeline";

/**
 * Data contracts between the demo CLI (which writes ../out) and the web app.
 * In production these become Supabase queries; the shapes stay the same.
 */
export interface Manifest {
  generatedAt: string;
  provider: string;
  toast: { asOf: string };
  briefs: Array<{ id: string; client: string; campaign: string; dir: string }>;
}

export interface ToastBundle {
  asOf: string;
  days: number;
  insights: Insight[];
  narrative: Narrative;
  answers: Answer[];
}

export interface AgentRun {
  asOf: string;
  autonomy: string;
  dryRun: boolean;
  recommendations: Recommendation[];
  alerts: Alert[];
  briefs: Array<{ clientId: string; clientName: string; brief: DailyBrief }>;
  actions: Array<{ recommendationId: string; ok: boolean; dryRun: boolean; detail: string }>;
}

export type PreviewKind = "ideas" | "copy" | "creatives" | "scripts" | "ugc" | "landing" | "launch";

export interface ReviewItem extends GateRecord {
  id: string;
  summary: string;
  preview: { kind: PreviewKind; data: unknown };
}

export interface ReviewQueue {
  briefId: string;
  client: string;
  campaign: string;
  status: string;
  items: ReviewItem[];
  quality?: { meanOverall: number; verdictCounts: Record<string, number> };
  cost?: { llmCalls: number; costUsd: number };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const loadManifest = () => getJson<Manifest>("/manifest.json");
export const loadDataset = () => getJson<AdsDataset>("/toast/dataset.json");
export const loadToastBundle = () => getJson<ToastBundle>("/toast/insights.json");
export const loadAgentRun = () => getJson<AgentRun>("/agent/run.json");
export const loadReviewQueue = (dir: string) => getJson<ReviewQueue>(`/${dir}/review-queue.json`);

/** Local decision store so the demo review queue remembers clicks; production writes review_gates. */
const KEY = "ai-studio.decisions";
export type LocalDecision = { status: "approved" | "rejected"; at: string; note?: string };

export function readDecisions(): Record<string, LocalDecision> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, LocalDecision>;
  } catch {
    return {};
  }
}

export function writeDecision(id: string, decision: LocalDecision | null): Record<string, LocalDecision> {
  const all = readDecisions();
  if (decision) all[id] = decision;
  else delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private mode or blocked storage: keep in memory only
  }
  return all;
}

export const money = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
export const pct = (n: number) => `${n > 0 ? "+" : ""}${n}%`;

import { z } from "zod";
import type { AdsDataset } from "../../core/ads";
import { AuditLog } from "../../core/audit";
import type { LLMProvider } from "../../core/llm/provider";
import { defineTask } from "../../core/llm/provider";
import { buildWindows, evaluateRules, riskOrder } from "./rules";
import { RulesConfigSchema, type ActionResult, type Alert, type AutonomyLevel, type MetaAdsClient, type Recommendation, type RulesConfig } from "./types";
import { round2 } from "../../core/num";

/**
 * The Media Buyer agent. Each daily run:
 *  1. builds per-ad-set windows from the metrics table
 *  2. runs the deterministic rules -> recommendations with a risk tier
 *  3. asks the LLM to write the morning brief (explain + prioritise, never decide)
 *  4. raises alerts for critical items
 *  5. executes only what the autonomy level and approvals allow, via the ads client
 * Everything is written to the audit log.
 */

export const DailyBriefSchema = z.object({
  headline: z.string().min(5),
  summary: z.string().min(20),
  priorities: z.array(z.object({ recommendationId: z.string(), why: z.string().min(5) })).default([]),
  watchlist: z.array(z.string()).default([]),
});
export type DailyBrief = z.infer<typeof DailyBriefSchema>;

export interface BriefInput {
  asOf: string;
  clientName: string;
  totals: { spend: number; revenue: number; roas: number; conversions: number; cpa: number };
  recommendations: Array<Pick<Recommendation, "id" | "title" | "rationale" | "risk" | "type">>;
}

export const dailyBriefTask = defineTask<BriefInput, DailyBrief>({
  name: "mediaBuyer.dailyBrief",
  description: "Write the media buyer's morning brief from rule findings",
  schema: DailyBriefSchema,
  system: `You are a senior paid-social media buyer writing a 60-second morning brief for a colleague.
You are given the account totals and a list of rule-based findings. Do not invent findings or numbers; only explain, prioritise and connect the ones you are given.
Lead with what needs a human decision today, then quick wins, then what to watch. Plain English, no jargon the client could not follow.`,
  effort: "low",
  prompt: (input) =>
    [
      `Date: ${input.asOf}. Client: ${input.clientName}.`,
      `Totals (last 7 days): spend £${input.totals.spend}, revenue £${input.totals.revenue}, ROAS ${input.totals.roas}, donations ${input.totals.conversions}, CPA £${input.totals.cpa}.`,
      `Findings:`,
      ...input.recommendations.map((r) => `- [${r.id}] (${r.risk}) ${r.title}: ${r.rationale}`),
    ].join("\n"),
  mock: (input) => {
    const human = input.recommendations.filter((r) => r.risk === "human");
    const approve = input.recommendations.filter((r) => r.risk === "approve");
    const headline = human.length
      ? `${human.length} decision${human.length > 1 ? "s" : ""} needed for ${input.clientName} today`
      : approve.length
        ? `${approve.length} quick win${approve.length > 1 ? "s" : ""} ready to approve for ${input.clientName}`
        : `${input.clientName}: steady, no action needed`;
    const summary = `Last 7 days: £${input.totals.spend} spent, £${input.totals.revenue} raised (ROAS ${input.totals.roas}) from ${input.totals.conversions} donations at £${input.totals.cpa} CPA. ${human.length ? `Start with ${human[0]!.title.toLowerCase()}.` : ""} ${approve.length ? `${approve.length} budget or creative change${approve.length > 1 ? "s" : ""} are ready for one-click approval.` : ""}`.trim();
    return {
      headline,
      summary,
      priorities: [...human, ...approve].slice(0, 5).map((r) => ({ recommendationId: r.id, why: r.rationale.split(". ")[0] ?? r.title })),
      watchlist: input.recommendations.filter((r) => r.risk === "auto").map((r) => r.title),
    };
  },
});

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["assist", "copilot", "autopilot"];

/** Default wall-clock budget for one ads-API call; after the first timeout the rest of the run skips the API. */
export const DEFAULT_ACTION_TIMEOUT_MS = 2500;

export interface AgentRunOptions {
  data: AdsDataset;
  asOf: string;
  provider: LLMProvider;
  adsClient: MetaAdsClient;
  autonomy: AutonomyLevel;
  /** Per-call timeout for the ads client (ms). */
  actionTimeoutMs?: number;
  config?: Partial<RulesConfig>;
  /** Recommendation ids a human has approved before this run (one-click approvals). */
  approvedIds?: string[];
  dryRun?: boolean;
  audit?: AuditLog;
  clientFilter?: string[];
}

export interface AgentRunResult {
  asOf: string;
  recommendations: Recommendation[];
  alerts: Alert[];
  briefs: Array<{ clientId: string; clientName: string; brief: DailyBrief }>;
  actions: ActionResult[];
  audit: AuditLog;
}

export async function runMediaBuyerAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  if (!AUTONOMY_LEVELS.includes(options.autonomy)) {
    throw new Error(`Unknown autonomy level "${String(options.autonomy)}"; use ${AUTONOMY_LEVELS.join(", ")}.`);
  }
  const audit = options.audit ?? new AuditLog();
  const config = RulesConfigSchema.parse(options.config ?? {});
  const timeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  let apiUnresponsive = false;
  const approved = new Set(options.approvedIds ?? []);
  const dryRun = options.dryRun ?? false;
  const data = options.clientFilter
    ? { ...options.data, clients: options.data.clients.filter((c) => options.clientFilter!.includes(c.id)), adsets: options.data.adsets.filter((a) => options.clientFilter!.includes(a.clientId)) }
    : options.data;

  const windows = buildWindows(data, options.asOf, config);
  const recommendations = evaluateRules(windows, config, options.asOf);
  audit.record("note", "media-buyer", "rules", { asOf: options.asOf, adsets: windows.length, recommendations: recommendations.length });

  const alerts: Alert[] = recommendations
    .filter((r) => r.risk === "human" || r.rule === "tracking-break")
    .map((r) => ({
      id: `alert:${r.id}`,
      severity: r.rule === "tracking-break" ? "critical" : "warning",
      title: r.title,
      message: r.rationale,
      entityIds: [r.entity.id],
      clientId: r.entity.clientId,
      channel: "slack",
    }));

  const briefs: AgentRunResult["briefs"] = [];
  for (const client of data.clients) {
    const clientWindows = windows.filter((w) => w.clientId === client.id);
    const totals = clientWindows.reduce(
      (t, w) => ({ spend: t.spend + w.recent.spend, revenue: t.revenue + w.recent.revenue, conversions: t.conversions + w.recent.conversions }),
      { spend: 0, revenue: 0, conversions: 0 },
    );
    const clientRecs = recommendations.filter((r) => r.entity.clientId === client.id);
    const input: BriefInput = {
      asOf: options.asOf,
      clientName: client.name,
      totals: {
        spend: round2(totals.spend),
        revenue: round2(totals.revenue),
        roas: totals.spend > 0 ? round2(totals.revenue / totals.spend) : 0,
        conversions: totals.conversions,
        cpa: totals.conversions > 0 ? round2(totals.spend / totals.conversions) : 0,
      },
      recommendations: clientRecs.map((r) => ({ id: r.id, title: r.title, rationale: r.rationale, risk: r.risk, type: r.type })),
    };
    const result = await options.provider.run(dailyBriefTask, input);
    audit.record("llm_call", "media-buyer", "dailyBrief", { clientId: client.id }, result.usage);
    briefs.push({ clientId: client.id, clientName: client.name, brief: result.output });
  }

  const actions: ActionResult[] = [];
  for (const r of recommendations) {
    const decision = decideExecution(r, options.autonomy, approved, config);
    audit.record("review", "media-buyer", "policy", { recommendationId: r.id, risk: r.risk, decision });
    if (decision === "skip") continue;
    const result = apiUnresponsive
      ? { recommendationId: r.id, ok: false, dryRun, detail: "Skipped: the ads API timed out earlier in this run" }
      : await execute(r, options.adsClient, dryRun, timeoutMs);
    if (!result.ok && /timed out/.test(result.detail)) apiUnresponsive = true;
    r.status = result.ok ? (decision === "auto" ? "auto_executed" : "executed") : "failed";
    actions.push(result);
    audit.record("action", "media-buyer", r.type, { recommendationId: r.id, entity: r.entity, change: r.proposedChange ?? null, dryRun, ok: result.ok, detail: result.detail });
  }

  return { asOf: options.asOf, recommendations, alerts, briefs, actions, audit };
}

/** Pure policy: given the autonomy level, approvals and caps, should this run now? */
export function decideExecution(r: Recommendation, autonomy: AutonomyLevel, approved: Set<string>, config: RulesConfig): "auto" | "approved" | "skip" {
  if (!r.proposedChange) return "skip"; // notify/investigate items have nothing to execute
  if (approved.has(r.id)) return "approved";
  if (r.risk === "human") return "skip";
  if (autonomy === "assist") return "skip";
  if (r.risk === "auto") return "auto";
  if (autonomy === "autopilot" && r.risk === "approve") {
    if (r.proposedChange.field === "daily_budget_gbp") {
      const from = Number(r.proposedChange.from);
      const to = Number(r.proposedChange.to);
      const changePct = from > 0 ? Math.abs((to - from) / from) * 100 : 100;
      if (changePct <= config.maxAutoBudgetChangePct && to <= config.maxDailyBudgetGbp) return "auto";
      return "skip";
    }
    // Pausing a single ad on autopilot is allowed; pausing an ad set is not.
    if (r.type === "pause_ad") return "auto";
  }
  return "skip";
}

async function execute(r: Recommendation, client: MetaAdsClient, dryRun: boolean, timeoutMs: number): Promise<ActionResult> {
  if (dryRun) return { recommendationId: r.id, ok: true, dryRun: true, detail: `DRY RUN: would ${describe(r)}` };
  try {
    let call: Promise<{ ok: boolean; detail: string }>;
    if (r.proposedChange?.field === "daily_budget_gbp") call = client.updateAdsetBudget(r.entity.id, Number(r.proposedChange.to));
    else if (r.type === "pause_ad") call = client.pauseAd(r.entity.id);
    else if (r.type === "pause_adset" || r.type === "refresh_creative") call = r.entity.level === "ad" ? client.pauseAd(r.entity.id) : client.pauseAdset(r.entity.id);
    else call = Promise.resolve({ ok: false, detail: `No executor for ${r.type}` });
    const res = await withTimeout(call, timeoutMs, `${describe(r)} timed out after ${timeoutMs} ms`);
    return { recommendationId: r.id, ok: res.ok, dryRun: false, detail: res.detail };
  } catch (err) {
    return { recommendationId: r.id, ok: false, dryRun: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Slack mrkdwn: escape the three control characters so names from the ad account cannot inject @channel or links. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function describe(r: Recommendation): string {
  if (!r.proposedChange) return r.title;
  return `${r.type.replace(/_/g, " ")} on ${r.entity.level} ${r.entity.name}: ${r.proposedChange.field} ${r.proposedChange.from} -> ${r.proposedChange.to}`;
}

/** In-memory ads client that records calls; idempotent on repeated identical changes. */
export class MockMetaAdsClient implements MetaAdsClient {
  readonly name = "mock-meta-ads";
  readonly calls: Array<{ method: string; id: string; value?: number }> = [];
  readonly state = new Map<string, { status?: string; budget?: number }>();
  constructor(private readonly failIds: Set<string> = new Set()) {}

  async updateAdsetBudget(adsetId: string, dailyBudgetGbp: number) {
    if (this.failIds.has(adsetId)) return { ok: false, detail: "Meta API error: (#100) Invalid parameter" };
    const current = this.state.get(adsetId);
    if (current?.budget === dailyBudgetGbp) return { ok: true, detail: `Budget already £${dailyBudgetGbp}; no-op` };
    this.calls.push({ method: "updateAdsetBudget", id: adsetId, value: dailyBudgetGbp });
    this.state.set(adsetId, { ...current, budget: dailyBudgetGbp });
    return { ok: true, detail: `Ad set ${adsetId} daily budget set to £${dailyBudgetGbp}` };
  }
  async pauseAd(adId: string) {
    if (this.failIds.has(adId)) return { ok: false, detail: "Meta API error: (#10) Permission denied" };
    const current = this.state.get(adId);
    if (current?.status === "PAUSED") return { ok: true, detail: `Ad ${adId} already paused; no-op` };
    this.calls.push({ method: "pauseAd", id: adId });
    this.state.set(adId, { ...current, status: "PAUSED" });
    return { ok: true, detail: `Ad ${adId} paused` };
  }
  async pauseAdset(adsetId: string) {
    const current = this.state.get(adsetId);
    if (current?.status === "PAUSED") return { ok: true, detail: `Ad set ${adsetId} already paused; no-op` };
    this.calls.push({ method: "pauseAdset", id: adsetId });
    this.state.set(adsetId, { ...current, status: "PAUSED" });
    return { ok: true, detail: `Ad set ${adsetId} paused` };
  }
}

export function formatSlackAlert(alert: Alert): string {
  const icon = alert.severity === "critical" ? ":rotating_light:" : alert.severity === "warning" ? ":warning:" : ":information_source:";
  return `${icon} *${escapeSlack(alert.title)}*\n${escapeSlack(alert.message)}\n_Entities: ${alert.entityIds.map(escapeSlack).join(", ")}_`;
}

export function recommendationsToMarkdown(recs: Recommendation[]): string {
  if (!recs.length) return "_No recommendations today._";
  const sorted = [...recs].sort((a, b) => riskOrder(b.risk) - riskOrder(a.risk));
  return [
    "| Risk | Type | Entity | Title | Change | Status |",
    "|---|---|---|---|---|---|",
    ...sorted.map((r) => `| ${r.risk} | ${r.type} | ${r.entity.level}: ${r.entity.name} | ${r.title} | ${r.proposedChange ? `${r.proposedChange.field}: ${r.proposedChange.from} → ${r.proposedChange.to}` : "—"} | ${r.status} |`),
  ].join("\n");
}


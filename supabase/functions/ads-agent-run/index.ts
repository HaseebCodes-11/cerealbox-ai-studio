/**
 * POST /ads-agent-run  { asOf?, autonomy?: "assist"|"copilot"|"autopilot", dryRun?: boolean, clientIds?: string[] }
 * Daily Media Buyer agent run. Writes agent_runs, agent_recommendations and
 * agent_actions, then posts the recommendations to the n8n approval webhook.
 * The Meta access token never leaves this function.
 */
import { createClient } from "@supabase/supabase-js";
import { getProvider } from "../../../src/core/llm/index";
import { runMediaBuyerAgent } from "../../../src/areas/media-buyer/index";
import type { MetaAdsClient } from "../../../src/areas/media-buyer/types";
import type { AdsDataset } from "../../../src/core/ads";
import { error, json, readJson, requireEnv, requireServiceRole } from "../_shared/http";

declare const Deno: { env: { get(k: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

/** Thin Marketing API client. Budgets are sent in minor units (pence). */
class MetaMarketingApiClient implements MetaAdsClient {
  readonly name = "meta-marketing-api";
  constructor(private readonly token: string, private readonly version = "v21.0") {}
  private async post(path: string, body: Record<string, string>) {
    const res = await fetch(`https://graph.facebook.com/${this.version}/${path}`, { method: "POST", body: new URLSearchParams({ ...body, access_token: this.token }) });
    const data = (await res.json()) as { success?: boolean; error?: { message: string } };
    return res.ok && !data.error ? { ok: true, detail: `${path} updated` } : { ok: false, detail: data.error?.message ?? `HTTP ${res.status}` };
  }
  updateAdsetBudget(adsetId: string, dailyBudgetGbp: number) {
    return this.post(adsetId, { daily_budget: String(Math.round(dailyBudgetGbp * 100)) });
  }
  pauseAd(adId: string) {
    return this.post(adId, { status: "PAUSED" });
  }
  pauseAdset(adsetId: string) {
    return this.post(adsetId, { status: "PAUSED" });
  }
}

async function loadDataset(supabase: ReturnType<typeof createClient>, asOf: string): Promise<AdsDataset> {
  const since = new Date(`${asOf}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 20);
  const start = since.toISOString().slice(0, 10);
  const [clients, campaigns, adsets, ads, metrics] = await Promise.all([
    supabase.from("clients").select("*"),
    supabase.from("campaigns").select("*"),
    supabase.from("adsets").select("*"),
    supabase.from("ads").select("*"),
    supabase.from("ad_metrics_daily").select("*").gte("date", start).lte("date", asOf),
  ]);
  for (const r of [clients, campaigns, adsets, ads, metrics]) if (r.error) throw new Error(r.error.message);
  return {
    clients: (clients.data ?? []).map((c) => ({ id: c.id, name: c.name, adAccountId: c.ad_account_id, targetRoas: c.target_roas, targetCpaGbp: c.target_cpa_gbp })),
    campaigns: (campaigns.data ?? []).map((c) => ({ id: c.id, clientId: c.client_id, name: c.name, objective: c.objective, status: c.status })),
    adsets: (adsets.data ?? []).map((a) => ({ id: a.id, campaignId: a.campaign_id, clientId: a.client_id, name: a.name, dailyBudgetGbp: a.daily_budget_gbp, status: a.status, learningStatus: a.learning_status })),
    ads: (ads.data ?? []).map((a) => ({ id: a.id, adsetId: a.adset_id, campaignId: a.campaign_id, clientId: a.client_id, name: a.name, creativeType: a.creative_type, status: a.status, launchedOn: a.launched_on })),
    metrics: (metrics.data ?? []).map((m) => ({ date: m.date, clientId: m.client_id, campaignId: m.campaign_id, adsetId: m.adset_id, adId: m.ad_id, spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, linkClicks: m.link_clicks, conversions: m.conversions, revenue: m.revenue })),
    range: { start, end: asOf },
  };
}

Deno.serve(async (req) => {
  const denied = requireServiceRole(req);
  if (denied) return denied;
  const body = await readJson<{ asOf?: string; autonomy?: "assist" | "copilot" | "autopilot"; dryRun?: boolean; clientIds?: string[] }>(req);
  const asOf = body.asOf ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const autonomy = body.autonomy ?? "assist";
  const dryRun = body.dryRun ?? true;
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  try {
    const data = await loadDataset(supabase, asOf);
    const approved = await supabase.from("agent_recommendations").select("id").eq("status", "approved");
    const provider = await getProvider({ LLM_PROVIDER: Deno.env.get("LLM_PROVIDER") ?? "anthropic", ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY"), ANTHROPIC_MODEL: Deno.env.get("ANTHROPIC_MODEL") });
    const adsClient = new MetaMarketingApiClient(Deno.env.get("META_ACCESS_TOKEN") ?? "");
    const run = await runMediaBuyerAgent({ data, asOf, provider, adsClient, autonomy, dryRun, approvedIds: (approved.data ?? []).map((r) => r.id as string), ...(body.clientIds ? { clientFilter: body.clientIds } : {}) });

    const { data: runRow, error: runError } = await supabase.from("agent_runs").insert({ as_of: asOf, autonomy, dry_run: dryRun, config: {}, adsets_seen: data.adsets.length }).select("id").single();
    if (runError) return error(runError.message, 500);
    const recs = run.recommendations.map((r) => ({
      id: r.id,
      run_id: runRow.id,
      client_id: r.entity.clientId,
      rule: r.rule,
      type: r.type,
      entity_level: r.entity.level,
      entity_id: r.entity.id,
      entity_name: r.entity.name,
      title: r.title,
      rationale: r.rationale,
      evidence: r.evidence,
      risk: r.risk,
      confidence: r.confidence,
      proposed_change: r.proposedChange ?? null,
      status: r.status,
    }));
    if (recs.length) await supabase.from("agent_recommendations").upsert(recs, { onConflict: "id" });
    if (run.actions.length) await supabase.from("agent_actions").insert(run.actions.map((a) => ({ recommendation_id: a.recommendationId, dry_run: a.dryRun, ok: a.ok, detail: a.detail })));

    const webhook = Deno.env.get("N8N_AGENT_WEBHOOK_URL");
    if (webhook) await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asOf, recommendations: run.recommendations.filter((r) => r.status === "proposed") }) });

    return json({ asOf, autonomy, dryRun, recommendations: run.recommendations.length, alerts: run.alerts.length, actions: run.actions.length, briefs: run.briefs });
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err), 500);
  }
});

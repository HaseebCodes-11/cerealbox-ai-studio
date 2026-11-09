/**
 * POST /toast-insights  { asOf?: "YYYY-MM-DD", days?: 7 }
 * Computes Toast insights and the narrative for the window and stores the
 * digest in toast_digests. Triggered by pg_cron at 07:15 weekdays and by the
 * n8n digest workflow. Reads ad_metrics_daily through the aggregation layer.
 */
import { createClient } from "@supabase/supabase-js";
import { getProvider } from "../../../src/core/llm/index";
import { generateInsights, narrativeTask } from "../../../src/areas/toast/index";
import type { AdsDataset } from "../../../src/core/ads";
import { error, json, readJson, requireServiceRole } from "../_shared/http";

declare const Deno: { env: { get(k: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

async function loadDataset(asOf: string, days: number): Promise<AdsDataset> {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const start = new Date(`${asOf}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days * 2 + 28)); // enough history for anomalies and period comparison
  const since = start.toISOString().slice(0, 10);
  const [clients, campaigns, adsets, ads, metrics] = await Promise.all([
    supabase.from("clients").select("id,name,ad_account_id,target_roas,target_cpa_gbp"),
    supabase.from("campaigns").select("id,client_id,name,objective,status"),
    supabase.from("adsets").select("id,campaign_id,client_id,name,daily_budget_gbp,status,learning_status"),
    supabase.from("ads").select("id,adset_id,campaign_id,client_id,name,creative_type,status,launched_on"),
    supabase.from("ad_metrics_daily").select("*").gte("date", since).lte("date", asOf),
  ]);
  for (const r of [clients, campaigns, adsets, ads, metrics]) if (r.error) throw new Error(r.error.message);
  return {
    clients: (clients.data ?? []).map((c) => ({ id: c.id, name: c.name, adAccountId: c.ad_account_id, targetRoas: c.target_roas, targetCpaGbp: c.target_cpa_gbp })),
    campaigns: (campaigns.data ?? []).map((c) => ({ id: c.id, clientId: c.client_id, name: c.name, objective: c.objective, status: c.status })),
    adsets: (adsets.data ?? []).map((a) => ({ id: a.id, campaignId: a.campaign_id, clientId: a.client_id, name: a.name, dailyBudgetGbp: a.daily_budget_gbp, status: a.status, learningStatus: a.learning_status })),
    ads: (ads.data ?? []).map((a) => ({ id: a.id, adsetId: a.adset_id, campaignId: a.campaign_id, clientId: a.client_id, name: a.name, creativeType: a.creative_type, status: a.status, launchedOn: a.launched_on })),
    metrics: (metrics.data ?? []).map((m) => ({ date: m.date, clientId: m.client_id, campaignId: m.campaign_id, adsetId: m.adset_id, adId: m.ad_id, spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, linkClicks: m.link_clicks, conversions: m.conversions, revenue: m.revenue })),
    range: { start: since, end: asOf },
  };
}

Deno.serve(async (req) => {
  const denied = requireServiceRole(req);
  if (denied) return denied;
  const body = await readJson<{ asOf?: string; days?: number }>(req);
  const asOf = body.asOf ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const days = body.days ?? 7;
  try {
    const data = await loadDataset(asOf, days);
    const insights = generateInsights(data, asOf, days);
    const provider = await getProvider({ LLM_PROVIDER: Deno.env.get("LLM_PROVIDER") ?? "anthropic", ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY"), ANTHROPIC_MODEL: Deno.env.get("ANTHROPIC_MODEL") });
    const narrative = (await provider.run(narrativeTask, { asOf, days, insights })).output;
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: dbError } = await supabase.from("toast_digests").upsert({ as_of: asOf, insights, narrative }, { onConflict: "as_of" });
    if (dbError) return error(dbError.message, 500);
    return json({ asOf, days, insights, narrative });
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err), 500);
  }
});

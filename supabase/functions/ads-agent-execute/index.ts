/**
 * POST /ads-agent-execute  { recommendationId: string, approvedBy: string }
 * Executes one approved recommendation against the Meta Marketing API and
 * records the action. Called by the n8n approval workflow after a human
 * clicked Approve, or by the review screen in True ROAS.
 */
import { createClient } from "@supabase/supabase-js";
import { buildMetaExecutionRequest, MetaExecutionError } from "../../../src/areas/media-buyer/execute";
import { error, json, readJson, requireEnv, requireServiceRole } from "../_shared/http";

declare const Deno: { env: { get(k: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

Deno.serve(async (req) => {
  const denied = requireServiceRole(req);
  if (denied) return denied;
  const { recommendationId, approvedBy } = await readJson<{ recommendationId?: string; approvedBy?: string }>(req);
  if (!recommendationId) return error("recommendationId required");
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { data: rec, error: loadError } = await supabase.from("agent_recommendations").select("*").eq("id", recommendationId).single();
  if (loadError || !rec) return error("recommendation not found", 404);
  if (!["proposed", "approved"].includes(rec.status)) return error(`recommendation is ${rec.status}`, 409);
  let request;
  try {
    request = buildMetaExecutionRequest(String(rec.entity_level), rec.entity_id, rec.proposed_change as { field: string; to: string | number } | null);
  } catch (err) {
    if (err instanceof MetaExecutionError) return error(err.message, 409);
    throw err;
  }
  const { url, body } = request;

  const token = requireEnv("META_ACCESS_TOKEN");
  const res = await fetch(url, { method: "POST", body: new URLSearchParams({ ...body, access_token: token }) });
  const data = (await res.json()) as { error?: { message: string } };
  const ok = res.ok && !data.error;
  const detail = ok ? request.detail : data.error?.message ?? `HTTP ${res.status}`;

  await supabase.from("agent_actions").insert({ recommendation_id: recommendationId, dry_run: false, ok, detail, meta_request: body, meta_response: data });
  await supabase.from("agent_recommendations").update({ status: ok ? "executed" : "failed", decided_at: new Date().toISOString() }).eq("id", recommendationId);
  return json({ recommendationId, ok, detail, approvedBy: approvedBy ?? "unknown" }, ok ? 200 : 502);
});

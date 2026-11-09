/**
 * POST /run-pipeline-stage  { briefId: string, stage: "ideas"|"copy"|"scripts"|"landing" , ideaId?: string }
 * Runs one AI stage for a brief and writes the artefact plus a pending
 * review gate. The React review screen approves the gate, which triggers
 * the next stage. Statics/UGC/video render in a Node worker because they
 * need native modules (resvg, ffmpeg); this function covers the text stages.
 */
import { createClient } from "@supabase/supabase-js";
import { parseBrief } from "../../../src/core/brief";
import { getProvider } from "../../../src/core/llm/index";
import { ideaGenerationTask, rankIdeas, selectIdeas } from "../../../src/areas/ideas/index";
import { copyGenerationTask, validateCopy } from "../../../src/areas/copy/index";
import { scriptGenerationTask, validateScript } from "../../../src/areas/scripts/index";
import { checkLandingPage, landingSpecTask, renderLandingPage } from "../../../src/areas/landing/index";
import { error, json, readJson, requireEnv, requireServiceRole } from "../_shared/http";

declare const Deno: { env: { get(k: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

Deno.serve(async (req) => {
  const denied = requireServiceRole(req);
  if (denied) return denied;
  const body = await readJson<{ briefId?: string; stage?: string; ideaId?: string }>(req);
  if (!body.briefId || !body.stage) return error("briefId and stage required");
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { data: row, error: briefError } = await supabase.from("campaign_briefs").select("brief").eq("id", body.briefId).single();
  if (briefError || !row) return error("brief not found", 404);
  const brief = parseBrief(row.brief);
  const provider = await getProvider({ LLM_PROVIDER: Deno.env.get("LLM_PROVIDER") ?? "anthropic", ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY"), ANTHROPIC_MODEL: Deno.env.get("ANTHROPIC_MODEL") });

  const loadIdea = async () => {
    const { data } = await supabase.from("artefacts").select("payload").eq("brief_id", brief.id).eq("kind", "idea").eq("id", body.ideaId ?? "").maybeSingle();
    const { data: latest } = data ? { data } : await supabase.from("artefacts").select("payload").eq("brief_id", brief.id).eq("kind", "idea").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!latest) throw new Error("no idea artefact for this brief; run the ideas stage first");
    return latest.payload;
  };
  const loadCopy = async () => {
    const { data } = await supabase.from("artefacts").select("payload").eq("brief_id", brief.id).eq("kind", "copy_pack").order("version", { ascending: false }).limit(1).maybeSingle();
    if (!data) throw new Error("no copy pack for this brief; run the copy stage first");
    return data.payload;
  };
  const store = async (kind: string, payload: unknown, score: number | null, issues: unknown, gate: string, area: string, parentId?: string) => {
    const { data: artefact, error: insertError } = await supabase.from("artefacts").insert({ brief_id: brief.id, client_id: brief.client.id, kind, payload, guardrail_score: score, guardrail_issues: issues ?? [], parent_id: parentId ?? null }).select("id").single();
    if (insertError) throw new Error(insertError.message);
    await supabase.from("review_gates").insert({ brief_id: brief.id, client_id: brief.client.id, gate, area, risk: "human", artefact_id: artefact.id });
    return artefact.id as string;
  };

  try {
    switch (body.stage) {
      case "ideas": {
        const { data: previous } = await supabase.from("idea_bank").select("title,hook").eq("client_id", brief.client.id);
        const result = await provider.run(ideaGenerationTask, { brief, count: 10, previousIdeas: (previous ?? []).map((p) => `${p.title} ${p.hook}`), excludeAngles: [] });
        await supabase.from("model_calls").insert({ brief_id: brief.id, client_id: brief.client.id, area: "ideas", task_name: result.taskName, provider: result.usage.provider, model: result.usage.model, input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, cost_usd: result.usage.costUsd, latency_ms: result.usage.latencyMs });
        const ranked = rankIdeas(result.output.ideas, brief, { previousIdeas: (previous ?? []).map((p) => `${p.title} ${p.hook}`) });
        const selected = selectIdeas(ranked, 3, ["static", "video", "ugc", "landing"]);
        await supabase.from("idea_bank").insert(ranked.map((i) => ({ client_id: brief.client.id, brief_id: brief.id, angle: i.angle, title: i.title, hook: i.hook, concept: i.concept, scores: { ...i.scores, total: i.total } })));
        const ids: string[] = [];
        for (const idea of selected) ids.push(await store("idea", idea, null, [], "ideas.select", "ideas"));
        return json({ stage: "ideas", ranked: ranked.length, selected: ids });
      }
      case "copy": {
        const idea = await loadIdea();
        const result = await provider.run(copyGenerationTask, { brief, idea });
        const validation = validateCopy(result.output, brief);
        const id = await store("copy_pack", validation.cleaned, validation.overall.score, validation.overall.issues, "copy.approve", "copy");
        return json({ stage: "copy", artefactId: id, score: validation.overall.score, removed: validation.removed.length });
      }
      case "scripts": {
        const idea = await loadIdea();
        const copy = await loadCopy();
        const result = await provider.run(scriptGenerationTask, { brief, idea, copy, requests: [{ style: "ugc-testimonial", targetSeconds: 30 }, { style: "founder-direct", targetSeconds: 15 }, { style: "problem-solution", targetSeconds: 30 }] });
        const ids: string[] = [];
        for (const script of result.output.scripts) {
          const report = validateScript(script, brief);
          ids.push(await store("script", script, report.score, report.issues, "scripts.approve", "scripts"));
        }
        return json({ stage: "scripts", artefactIds: ids });
      }
      case "landing": {
        const idea = await loadIdea();
        const copy = await loadCopy();
        const ids: string[] = [];
        for (const variant of ["A", "B"] as const) {
          const spec = (await provider.run(landingSpecTask, { brief, idea, copy, variant })).output;
          const html = renderLandingPage(spec, brief.client);
          const report = checkLandingPage(spec, html, brief);
          const specId = await store("landing_spec", spec, report.score, report.issues, "landing.approve", "landing");
          await supabase.from("artefacts").insert({ brief_id: brief.id, client_id: brief.client.id, kind: "landing_html", payload: { variant }, parent_id: specId, storage_path: `landing/${brief.id}/${variant}.html` });
          await supabase.storage.from("artefacts").upload(`landing/${brief.id}/${variant}.html`, new Blob([html], { type: "text/html" }), { upsert: true });
          ids.push(specId);
        }
        return json({ stage: "landing", artefactIds: ids });
      }
      default:
        return error(`unknown stage ${body.stage}`);
    }
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err), 500);
  }
});

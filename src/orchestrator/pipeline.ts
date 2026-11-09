import { AuditLog } from "../core/audit";
import type { CampaignBrief } from "../core/brief";
import type { GuardrailReport } from "../core/guardrails";
import { mergeReports } from "../core/guardrails";
import type { LLMProvider } from "../core/llm/provider";
import { PolicyReviewer, type ReviewDecision, type Reviewer, type RiskTier } from "../core/review";
import { copyGenerationTask, hasMinimumViableCopy, validateCopy, type CopyPack, type CopyValidation } from "../areas/copy";
import { ideaGenerationTask, previousIdeaTexts, rankIdeas, recentlyUsedAngles, selectIdeas, toBankEntries, type IdeaAngle, type IdeaBankStore, type RankedIdea } from "../areas/ideas";
import { checkLandingPage, landingSpecTask, renderLandingPage, variantDiff, type LandingPageSpec } from "../areas/landing";
import { scriptGenerationTask, validateScript, type Script, type ScriptStyle } from "../areas/scripts";
import { checkCreative, creativeConceptTask, renderCreative, type CreativeFormatName, type ImageProvider, type RenderedCreative } from "../areas/static";
import { CREATIVE_FORMATS } from "../areas/static/types";
import { buildUgcManifest, personaTask, type UgcManifest } from "../areas/ugc";
import { analysePacing, buildEdl, buildFfmpegPlan, clipSelectionTask, toSrt, type Edl, type RawClip, type RenderStep } from "../areas/video";

/**
 * End-to-end campaign pipeline: Brief -> Ideas -> Copy -> Statics -> Scripts
 * -> UGC manifest -> Video edit plan -> Landing pages -> Launch plan.
 *
 * Every stage:
 *   1. calls one AI task through the provider (mock or Claude)
 *   2. runs deterministic guardrails/checks
 *   3. passes through a review gate (a human in production)
 *   4. writes to the audit log with token cost
 * If a gate returns "pending" the pipeline stops and returns what it has, so
 * the UI can show "waiting for review" rather than silently continuing.
 */

export interface PipelineOptions {
  brief: CampaignBrief;
  provider: LLMProvider;
  reviewer?: Reviewer;
  audit?: AuditLog;
  ideaCount?: number;
  selectCount?: number;
  previousIdeas?: string[];
  excludeAngles?: IdeaAngle[];
  formats?: CreativeFormatName[];
  scriptRequests?: Array<{ style: ScriptStyle; targetSeconds: 15 | 30 | 60 }>;
  allowSyntheticPresenter?: boolean;
  clips?: RawClip[];
  /** Generates photo backgrounds for photo-style creatives; omitted = labelled placeholder. */
  imageProvider?: ImageProvider;
  /** Remembers every idea per client so novelty scoring and angle rotation work across campaigns. */
  ideaBank?: IdeaBankStore;
  /** Date stamp for bank entries (defaults to today). */
  today?: string;
}

export interface GateRecord {
  gate: string;
  area: string;
  risk: RiskTier;
  guardrailScore: number;
  decision: ReviewDecision<unknown>["status"];
  reviewer?: string;
  reason?: string;
}

export interface LaunchPlan {
  campaign: { name: string; objective: string; dailyBudgetGbp: number; startDate?: string; endDate?: string };
  adsets: Array<{ name: string; placement: string; audience: string; dailyBudgetGbp: number; optimisation: string; ads: Array<{ name: string; creativeId: string; primaryTextVariant: string; headline: string; landingVariant: "A" | "B" }> }>;
  tracking: { utmTemplate: string; conversionEvent: string; attributionWindow: string };
  guardrailsForAgent: { targetRoas?: number; targetCpaGbp?: number; autonomy: "assist" };
}

export interface CampaignPackage {
  brief: CampaignBrief;
  status: "complete" | "awaiting_review" | "blocked";
  stoppedAt?: string;
  ideas: { ranked: RankedIdea[]; selected: RankedIdea[]; primary: RankedIdea | null };
  copy: { pack: CopyPack; validation: CopyValidation } | null;
  creatives: Array<{ rendered: RenderedCreative; report: GuardrailReport }>;
  scripts: Array<{ script: Script; report: GuardrailReport }>;
  ugc: UgcManifest | null;
  video: { edl: Edl; srt: string; plan: RenderStep[]; pacing: ReturnType<typeof analysePacing>; unmatchedBeats: string[] } | null;
  landing: Array<{ spec: LandingPageSpec; html: string; report: GuardrailReport }>;
  landingDiff: string[];
  launchPlan: LaunchPlan | null;
  gates: GateRecord[];
  audit: AuditLog;
}

export async function runCampaignPipeline(options: PipelineOptions): Promise<CampaignPackage> {
  const { brief, provider } = options;
  const reviewer = options.reviewer ?? new PolicyReviewer();
  const audit = options.audit ?? new AuditLog();
  const gates: GateRecord[] = [];

  const pkg: CampaignPackage = {
    brief,
    status: "complete",
    ideas: { ranked: [], selected: [], primary: null },
    copy: null,
    creatives: [],
    scripts: [],
    ugc: null,
    video: null,
    landing: [],
    landingDiff: [],
    launchPlan: null,
    gates,
    audit,
  };

  const gate = async <T>(name: string, area: string, artefact: T, report: GuardrailReport | undefined, risk: RiskTier, summary: string): Promise<boolean> => {
    const decision = await reviewer.review({ gate: name, area, artefact, guardrails: report, risk, summary });
    gates.push({
      gate: name,
      area,
      risk,
      guardrailScore: report?.score ?? 100,
      decision: decision.status,
      ...(decision.status !== "pending" ? { reviewer: decision.reviewer } : {}),
      ...("reason" in decision && decision.reason ? { reason: decision.reason } : {}),
    });
    audit.record("review", area, name, { decision: decision.status, score: report?.score ?? null, reason: "reason" in decision ? decision.reason : undefined });
    if (decision.status === "approved") return true;
    pkg.status = decision.status === "pending" ? "awaiting_review" : "blocked";
    pkg.stoppedAt = name;
    return false;
  };

  // 1. Ideas (with memory: the bank supplies previous ideas and recently used angles)
  const bankEntries = options.ideaBank ? await options.ideaBank.load(brief.client.id) : [];
  const previousIdeas = [...(options.previousIdeas ?? []), ...previousIdeaTexts(bankEntries)];
  const excludeAngles = [...new Set([...(options.excludeAngles ?? []), ...(recentlyUsedAngles(bankEntries) as IdeaAngle[])])];
  if (bankEntries.length) audit.record("note", "ideas", "bank", { previous: bankEntries.length, excludeAngles });
  const ideaResult = await provider.run(ideaGenerationTask, {
    brief,
    count: options.ideaCount ?? 10,
    previousIdeas,
    excludeAngles,
  });
  audit.record("llm_call", "ideas", "generate", { count: ideaResult.output.ideas.length }, ideaResult.usage);
  const ranked = rankIdeas(ideaResult.output.ideas, brief, { previousIdeas });
  const selected = selectIdeas(ranked, options.selectCount ?? 3, ["static", "video", "ugc", "landing"]);
  pkg.ideas = { ranked, selected, primary: selected[0] ?? null };
  if (options.ideaBank) await options.ideaBank.save(toBankEntries(ranked, selected, brief.client.id, brief.id, options.today ?? new Date().toISOString().slice(0, 10)));
  if (!pkg.ideas.primary) {
    pkg.status = "blocked";
    pkg.stoppedAt = "ideas";
    return pkg;
  }
  if (!(await gate("ideas.select", "ideas", selected, undefined, "human", `${selected.length} ideas shortlisted from ${ranked.length}; primary: ${pkg.ideas.primary.title}`))) return pkg;
  const idea = pkg.ideas.primary;

  // 2. Copy
  const copyResult = await provider.run(copyGenerationTask, { brief, idea });
  audit.record("llm_call", "copy", "generate", { idea: idea.id }, copyResult.usage);
  const validation = validateCopy(copyResult.output, brief);
  audit.record("guardrail", "copy", "validate", { score: validation.overall.score, removed: validation.removed.length });
  pkg.copy = { pack: validation.cleaned, validation };
  if (!hasMinimumViableCopy(validation.cleaned)) {
    pkg.status = "blocked";
    pkg.stoppedAt = "copy";
    gates.push({ gate: "copy.approve", area: "copy", risk: "human", guardrailScore: validation.overall.score, decision: "rejected", reason: "Too few variants survived guardrails" });
    return pkg;
  }
  if (!(await gate("copy.approve", "copy", validation.cleaned, { ...validation.overall, ok: true }, "human", `${validation.cleaned.primaryTexts.length} primary texts, ${validation.cleaned.headlines.length} headlines; ${validation.removed.length} removed by guardrails`))) return pkg;
  const copy = validation.cleaned;

  // 3. Static creatives
  const formats = options.formats ?? ["square", "story", "landscape"];
  const specResult = await provider.run(creativeConceptTask, { brief, idea, copy, formats });
  audit.record("llm_call", "static", "concept", { formats }, specResult.usage);
  for (const spec of specResult.output.specs) {
    let background: string | undefined;
    if (options.imageProvider && spec.imageStyle === "photo") {
      const { width, height } = CREATIVE_FORMATS[spec.format];
      const image = await options.imageProvider.generate({ prompt: spec.imagePrompt, width, height, palette: brief.client.brand, seed: spec.id });
      background = image.markup;
      audit.record("render", "static", `${spec.id}:background`, { provider: image.provider, raster: Boolean(image.dataUri) });
    }
    const rendered = renderCreative(spec, brief.client.brand, brief.client.name, background ? { background } : {});
    const report = checkCreative(rendered, brief.client.brand, brief);
    audit.record("render", "static", spec.id, { format: spec.format, layout: spec.layout, score: report.score, ok: report.ok, background: Boolean(background) });
    pkg.creatives.push({ rendered, report });
  }
  const passingCreatives = pkg.creatives.filter((c) => c.report.ok);
  if (!(await gate("static.approve", "static", passingCreatives.map((c) => c.rendered.spec), mergeReports(pkg.creatives.map((c) => c.report)), "human", `${passingCreatives.length}/${pkg.creatives.length} creatives pass automated QA`))) return pkg;

  // 4. Scripts
  const scriptRequests = options.scriptRequests ?? [
    { style: "ugc-testimonial", targetSeconds: 30 },
    { style: "founder-direct", targetSeconds: 15 },
    { style: "problem-solution", targetSeconds: 30 },
  ];
  const scriptResult = await provider.run(scriptGenerationTask, { brief, idea, copy, requests: scriptRequests });
  audit.record("llm_call", "scripts", "generate", { requests: scriptRequests.length }, scriptResult.usage);
  for (const script of scriptResult.output.scripts) {
    const report = validateScript(script, brief);
    audit.record("guardrail", "scripts", script.id, { score: report.score, ok: report.ok });
    pkg.scripts.push({ script, report });
  }
  const passingScripts = pkg.scripts.filter((s) => s.report.ok);
  if (!(await gate("scripts.approve", "scripts", passingScripts.map((s) => s.script), mergeReports(pkg.scripts.map((s) => s.report)), "human", `${passingScripts.length}/${pkg.scripts.length} scripts pass QA`))) return pkg;

  // 5. UGC manifest (from the first UGC-style script that passed, else the first passing script)
  const ugcScript = passingScripts.find((s) => s.script.style === "ugc-testimonial")?.script ?? passingScripts[0]?.script;
  if (ugcScript) {
    const personaResult = await provider.run(personaTask, { brief, script: ugcScript, allowSynthetic: options.allowSyntheticPresenter ?? false });
    audit.record("llm_call", "ugc", "persona", { script: ugcScript.id }, personaResult.usage);
    pkg.ugc = buildUgcManifest(ugcScript, brief, { persona: personaResult.output });
    audit.record("note", "ugc", "manifest", { id: pkg.ugc.id, synthetic: personaResult.output.synthetic, costGbp: pkg.ugc.estimatedCostGbp });
    if (!(await gate("ugc.persona", "ugc", pkg.ugc, undefined, "human", `Persona "${personaResult.output.name}" (${personaResult.output.synthetic ? "synthetic" : "real creator"}), est. £${pkg.ugc.estimatedCostGbp}`))) return pkg;
  }

  // 6. Video edit plan (only when footage is supplied)
  if (options.clips?.length && ugcScript) {
    const selection = await provider.run(clipSelectionTask, { script: ugcScript, clips: options.clips });
    audit.record("llm_call", "video", "selectClips", { selections: selection.output.selections.length, unmatched: selection.output.unmatchedBeats }, selection.usage);
    const edl = buildEdl(ugcScript, selection.output, options.clips, { brandName: brief.client.name });
    const srt = toSrt(edl.captions);
    const plan = buildFfmpegPlan(edl, options.clips);
    const pacing = analysePacing(edl);
    pkg.video = { edl, srt, plan, pacing, unmatchedBeats: selection.output.unmatchedBeats };
    audit.record("note", "video", "edl", { durationSec: edl.durationSec, cues: edl.captions.length, pacingIssues: pacing.issues });
  }

  // 7. Landing pages A/B
  for (const variant of ["A", "B"] as const) {
    const specResultLp = await provider.run(landingSpecTask, { brief, idea, copy, variant });
    audit.record("llm_call", "landing", `spec-${variant}`, {}, specResultLp.usage);
    const html = renderLandingPage(specResultLp.output, brief.client);
    const report = checkLandingPage(specResultLp.output, html, brief);
    audit.record("guardrail", "landing", `check-${variant}`, { score: report.score, ok: report.ok });
    pkg.landing.push({ spec: specResultLp.output, html, report });
  }
  if (pkg.landing.length === 2) pkg.landingDiff = variantDiff(pkg.landing[0]!.spec, pkg.landing[1]!.spec);
  if (!(await gate("landing.approve", "landing", pkg.landing.map((l) => l.spec), mergeReports(pkg.landing.map((l) => l.report)), "human", `${pkg.landing.filter((l) => l.report.ok).length}/2 variants pass QA; diff: ${pkg.landingDiff.length} field(s)`))) return pkg;

  // 8. Launch plan for the media buyer
  pkg.launchPlan = buildLaunchPlan(brief, idea.id, copy, passingCreatives.map((c) => c.rendered.spec.id));
  audit.record("note", "media-buyer", "launchPlan", { adsets: pkg.launchPlan.adsets.length });
  if (!(await gate("launch.approve", "media-buyer", pkg.launchPlan, undefined, "human", `${pkg.launchPlan.adsets.length} ad sets, £${pkg.launchPlan.campaign.dailyBudgetGbp}/day`))) return pkg;

  return pkg;
}

export function buildLaunchPlan(brief: CampaignBrief, ideaId: string, copy: CopyPack, creativeIds: string[]): LaunchPlan {
  const daily = brief.constraints.dailyBudgetGbp ?? 100;
  const placements = brief.channels.map((c) => (c === "meta_feed" ? "Feed" : c === "meta_stories" ? "Stories" : "Reels"));
  const audiences = ["Lookalike 1% previous donors", `Interests: ${brief.audience.name}`];
  const adsets: LaunchPlan["adsets"] = [];
  const share = Math.round((daily / (audiences.length * placements.length)) * 100) / 100;
  const headline = copy.headlines[0] ?? brief.offer.ask;
  for (const audience of audiences) {
    for (const placement of placements) {
      const creativeId = creativeIds.find((id) => (placement === "Feed" ? id.endsWith("square") || id.endsWith("landscape") : id.endsWith("story"))) ?? creativeIds[0] ?? "pending";
      adsets.push({
        name: `${brief.campaignName} · ${placement} · ${audience}`,
        placement,
        audience,
        dailyBudgetGbp: share,
        optimisation: brief.objective === "awareness" ? "REACH" : "OFFSITE_CONVERSIONS (Donate)",
        ads: copy.primaryTexts.slice(0, 2).map((p, i) => ({
          name: `${ideaId} · ${p.variant} · ${placement}`,
          creativeId,
          primaryTextVariant: p.variant,
          headline,
          landingVariant: i % 2 === 0 ? "A" : "B",
        })),
      });
    }
  }
  return {
    campaign: {
      name: brief.campaignName,
      objective: brief.objective,
      dailyBudgetGbp: daily,
      ...(brief.constraints.startDate ? { startDate: brief.constraints.startDate } : {}),
      ...(brief.constraints.endDate ? { endDate: brief.constraints.endDate } : {}),
    },
    adsets,
    tracking: {
      utmTemplate: `utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(brief.campaignName)}&utm_content={{ad.name}}`,
      conversionEvent: "Donate (Purchase) via Conversions API + pixel",
      attributionWindow: "7-day click, 1-day view",
    },
    guardrailsForAgent: {
      ...(brief.constraints.targetRoas ? { targetRoas: brief.constraints.targetRoas } : {}),
      ...(brief.constraints.targetCpaGbp ? { targetCpaGbp: brief.constraints.targetCpaGbp } : {}),
      autonomy: "assist",
    },
  };
}

/**
 * End-to-end demo: Brief -> Ideas -> Copy -> Statics -> Scripts -> UGC -> Video
 * edit plan -> Landing pages -> Launch plan, then Toast dashboard + Media Buyer
 * agent on the mock dataset. Writes everything to ./out.
 *
 *   npm run demo                      # mock provider, deterministic
 *   LLM_PROVIDER=anthropic npm run demo
 *   npm run demo -- --brief samples/brief-winter-warmth.json --allow-synthetic
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsd } from "../core/cost";
import { getProvider } from "../core/llm";
import { RecordingReviewer } from "../core/review";
import { runCampaignPipeline } from "../orchestrator";
import { getImageProvider, renderPng } from "../areas/static";
import { judgePackage } from "../evals/judge";
import { scriptToMarkdown } from "../areas/scripts";
import { generateMockDataset, generateInsights, insightsToMarkdown, narrativeTask, renderDashboard, askToast } from "../areas/toast";
import { runMediaBuyerAgent, MockMetaAdsClient, recommendationsToMarkdown, formatSlackAlert } from "../areas/media-buyer";
import { arg, flag, heading, json, loadBrief, loadClips, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const brief = loadBrief(arg("brief"));
  const clips = loadClips();
  const reviewer = new RecordingReviewer();
  const root = outDir(brief.id);

  heading(`CerealBox AI Studio demo · provider=${provider.name} · brief=${brief.campaignName}`);

  const imageProvider = getImageProvider();
  const pkg = await runCampaignPipeline({ brief, provider, reviewer, clips, allowSyntheticPresenter: flag("allow-synthetic"), imageProvider });
  const judgement = await judgePackage(pkg, provider);

  // Ideas
  writeOut(join(root, "01-ideas.json"), json(pkg.ideas));
  writeOut(
    join(root, "01-ideas.md"),
    [
      `# Ideas for ${brief.campaignName}`,
      ``,
      `| Rank | Idea | Angle | Total | Novelty | Clarity | Emotion | Brand fit | Feasibility | Formats | Flags |`,
      `|---|---|---|---|---|---|---|---|---|---|---|`,
      ...pkg.ideas.ranked.map((i) => `| ${i.rank} | **${i.title}**${pkg.ideas.selected.includes(i) ? " ✅" : ""} | ${i.angle} | ${i.total} | ${i.scores.novelty} | ${i.scores.clarity} | ${i.scores.emotionalPull} | ${i.scores.brandFit} | ${i.scores.feasibility} | ${i.formats.join(", ")} | ${i.riskFlags.join("; ") || "—"}${i.duplicateOf ? ` (dup of ${i.duplicateOf})` : ""} |`),
      ``,
      ...pkg.ideas.selected.flatMap((i) => [`## ${i.rank}. ${i.title} (${i.angle})`, ``, `**Hook:** ${i.hook}`, ``, i.concept, ``, `*Why it works:* ${i.whyItWorks}`, ``, `*Audience insight:* ${i.audienceInsight}`, ``, `*Visual direction:* ${i.visualDirection}`, ``]),
    ].join("\n"),
  );
  console.log(`Ideas: ${pkg.ideas.ranked.length} generated, ${pkg.ideas.selected.length} selected. Primary: ${pkg.ideas.primary?.title ?? "none"}`);

  // Copy
  if (pkg.copy) {
    const { pack, validation } = pkg.copy;
    writeOut(join(root, "02-copy.json"), json(pkg.copy));
    writeOut(
      join(root, "02-copy.md"),
      [
        `# Copy pack · ${brief.campaignName}`,
        ``,
        `Guardrail score: **${validation.overall.score}/100** · ${validation.removed.length} variant(s) removed · CTA button: \`${pack.ctaButton}\``,
        ``,
        `## Hooks`,
        ...pack.hooks.map((h) => `- ${h}`),
        ``,
        `## Headlines (≤40 chars recommended)`,
        ...pack.headlines.map((h) => `- ${h} _(${h.length})_`),
        ``,
        `## Primary text`,
        ...pack.primaryTexts.flatMap((p) => [`### ${p.variant} _(${p.text.length} chars)_`, ``, p.text, ``]),
        `## Descriptions`,
        ...pack.descriptions.map((d) => `- ${d}`),
        ``,
        `## Story / Reels overlays`,
        ...pack.storyOverlays.map((s) => `- ${s}`),
        ``,
        `## Messaging pillars`,
        ...pack.messagingPillars.map((m) => `- ${m}`),
        ``,
        `## Guardrail notes`,
        ...validation.fields.filter((f) => f.report.issues.length).map((f) => `- **${f.field}[${f.index}]** ${f.report.issues.map((i) => `${i.severity}: ${i.message}${i.excerpt ? ` ("${i.excerpt}")` : ""}`).join("; ")}`),
      ].join("\n"),
    );
    console.log(`Copy: score ${validation.overall.score}, ${pack.primaryTexts.length} primary texts, ${pack.headlines.length} headlines`);
  }

  // Creatives
  const creativeDir = outDir(brief.id, "03-creatives");
  for (const c of pkg.creatives) {
    writeOut(join(creativeDir, `${c.rendered.spec.id}.svg`), c.rendered.svg);
    const png = await renderPng(c.rendered.svg);
    if (png) writeOut(join(creativeDir, `${c.rendered.spec.id}.png`), png);
  }
  writeOut(join(creativeDir, "specs.json"), json(pkg.creatives.map((c) => ({ spec: c.rendered.spec, report: c.report }))));
  writeOut(
    join(root, "03-creatives.md"),
    [
      `# Static creatives`,
      ``,
      `| Creative | Format | Layout | QA | Score | Issues |`,
      `|---|---|---|---|---|---|`,
      ...pkg.creatives.map((c) => `| ${c.rendered.spec.id} | ${c.rendered.spec.format} (${c.rendered.width}×${c.rendered.height}) | ${c.rendered.spec.layout} | ${c.report.ok ? "✅" : "❌"} | ${c.report.score} | ${c.report.issues.map((i) => `${i.severity}: ${i.message}`).join("; ") || "—"} |`),
      ``,
      ...pkg.creatives.map((c) => `![${c.rendered.spec.id}](03-creatives/${c.rendered.spec.id}.png)`),
    ].join("\n"),
  );
  console.log(`Creatives: ${pkg.creatives.filter((c) => c.report.ok).length}/${pkg.creatives.length} pass QA (SVG + PNG in ${creativeDir})`);

  // Scripts
  writeOut(join(root, "04-scripts.json"), json(pkg.scripts));
  writeOut(join(root, "04-scripts.md"), [`# Scripts`, ``, ...pkg.scripts.flatMap((s) => [scriptToMarkdown(s.script), ``, `QA: ${s.report.ok ? "✅" : "❌"} ${s.report.score}/100 ${s.report.issues.map((i) => `· ${i.severity}: ${i.message}`).join(" ")}`, ``])].join("\n"));
  console.log(`Scripts: ${pkg.scripts.filter((s) => s.report.ok).length}/${pkg.scripts.length} pass QA`);

  // UGC
  if (pkg.ugc) {
    writeOut(join(root, "05-ugc-manifest.json"), json(pkg.ugc));
    console.log(`UGC: persona "${pkg.ugc.persona.name}" via ${pkg.ugc.avatar.provider}, est. £${pkg.ugc.estimatedCostGbp}, ${pkg.ugc.estimatedTurnaroundHours}h, disclosure=${pkg.ugc.disclosure.aiGenerated}`);
  }

  // Video
  if (pkg.video) {
    const videoDir = outDir(brief.id, "06-video");
    writeOut(join(videoDir, "edl.json"), json(pkg.video.edl));
    writeOut(join(videoDir, "captions.srt"), pkg.video.srt);
    writeOut(join(videoDir, "render-plan.sh"), ["#!/usr/bin/env bash", "set -euo pipefail", "mkdir -p render", ...pkg.video.plan.map((s) => `# ${s.name}\n${s.command}`)].join("\n\n") + "\n");
    writeOut(join(videoDir, "pacing.json"), json(pkg.video.pacing));
    console.log(`Video: EDL ${pkg.video.edl.durationSec}s, ${pkg.video.edl.captions.length} caption cues, ${pkg.video.plan.length} render steps, pacing issues: ${pkg.video.pacing.issues.length}`);
  }

  // Landing
  const landingDir = outDir(brief.id, "07-landing");
  for (const l of pkg.landing) {
    writeOut(join(landingDir, `variant-${l.spec.variant}.html`), l.html);
    writeOut(join(landingDir, `variant-${l.spec.variant}.spec.json`), json({ spec: l.spec, report: l.report }));
  }
  writeOut(join(landingDir, "ab-diff.md"), [`# A/B diff`, ``, ...pkg.landingDiff.map((d) => `- ${d}`), ``, `Hypothesis B: ${pkg.landing[1]?.spec.variantHypothesis ?? ""}`].join("\n"));
  console.log(`Landing pages: ${pkg.landing.filter((l) => l.report.ok).length}/${pkg.landing.length} pass QA (${landingDir})`);

  // Quality judgement
  writeOut(join(root, "11-quality-judgement.json"), json(judgement));
  writeOut(
    join(root, "11-quality-judgement.md"),
    [
      `# Creative quality · LLM-as-judge (${provider.name})`,
      ``,
      `Mean overall **${judgement.meanOverall}/10** · ship ${judgement.verdictCounts.ship} · revise ${judgement.verdictCounts.revise} · reject ${judgement.verdictCounts.reject}`,
      ``,
      `| Artefact | Clarity | Specificity | Emotion | Brand fit | Overall | Verdict |`,
      `|---|---|---|---|---|---|---|`,
      ...judgement.items.map((i) => `| ${i.artefactType}: ${i.label} | ${i.judgement.clarity} | ${i.judgement.specificity} | ${i.judgement.emotionalPull} | ${i.judgement.brandFit} | ${i.judgement.overall} | ${i.judgement.verdict} |`),
      ``,
      ...judgement.items.flatMap((i) => [`## ${i.artefactType}: ${i.label}`, ...i.judgement.strengths.map((s) => `- ✅ ${s}`), ...i.judgement.weaknesses.map((w) => `- ⚠️ ${w}`), ``]),
    ].join("\n"),
  );
  console.log(`Quality: judge mean ${judgement.meanOverall}/10 (${judgement.verdictCounts.ship} ship, ${judgement.verdictCounts.revise} revise, ${judgement.verdictCounts.reject} reject)`);

  // Launch plan + gates + audit
  if (pkg.launchPlan) writeOut(join(root, "08-launch-plan.json"), json(pkg.launchPlan));
  writeOut(join(root, "09-review-gates.md"), [`# Review gates`, ``, `| Gate | Area | Risk | Guardrail score | Decision | Reviewer | Reason |`, `|---|---|---|---|---|---|---|`, ...pkg.gates.map((g) => `| ${g.gate} | ${g.area} | ${g.risk} | ${g.guardrailScore} | ${g.decision} | ${g.reviewer ?? "—"} | ${g.reason ?? "—"} |`)].join("\n"));
  writeOut(join(root, "10-audit.json"), json(pkg.audit.toJSON()));
  const totals = pkg.audit.totals();

  // Toast + agent
  const asOf = arg("as-of", "2026-11-08")!;
  const data = generateMockDataset({ asOf });
  const insights = generateInsights(data, asOf);
  const narrative = (await provider.run(narrativeTask, { asOf, days: 7, insights })).output;
  const adsClient = new MockMetaAdsClient();
  const agent = await runMediaBuyerAgent({ data, asOf, provider, adsClient, autonomy: "copilot", dryRun: true });
  const questions = ["Which client had the biggest ROAS drop last week?", "How is Hearthline doing?", "Do video or static creatives perform better?", "Anything unusual this week?", "How much did we spend in total last 28 days?"];
  const answers = [];
  for (const q of questions) answers.push(await askToast(q, data, asOf, provider));
  const toastDir = outDir("toast");
  writeOut(join(toastDir, "dashboard.html"), renderDashboard({ data, asOf, insights, narrative, recommendations: agent.recommendations, sampleAnswers: answers }));
  writeOut(join(toastDir, "insights.md"), [`# Toast insights · ${asOf}`, ``, `## ${narrative.headline}`, ``, ...narrative.paragraphs, ``, `### Actions today`, ...narrative.actionsToday.map((a) => `- ${a}`), ``, `## All insights`, insightsToMarkdown(insights)].join("\n"));
  writeOut(join(toastDir, "dataset.json"), json(data));
  writeOut(join(toastDir, "ask-toast.md"), [`# Ask Toast · sample answers`, ``, ...answers.flatMap((a) => [`**Q: ${a.question}**`, ``, a.text, ``, `_intent: ${a.intent.intent} · metric: ${a.intent.metric} · ${a.sources.join(", ")}_`, ``])].join("\n"));
  writeOut(join(toastDir, "insights.json"), json({ asOf, days: 7, insights, narrative, answers }));
  const agentDir = outDir("agent");
  writeOut(join(agentDir, "run.json"), json({ asOf, autonomy: "copilot", dryRun: true, recommendations: agent.recommendations, alerts: agent.alerts, briefs: agent.briefs, actions: agent.actions }));
  writeOut(join(agentDir, "recommendations.md"), [`# Media Buyer agent · ${asOf} · autonomy=copilot · dry run`, ``, recommendationsToMarkdown(agent.recommendations), ``, `## Actions`, ...agent.actions.map((a) => `- ${a.ok ? "✅" : "❌"} ${a.detail}`)].join("\n"));
  writeOut(join(agentDir, "alerts.md"), [`# Alerts`, ``, ...agent.alerts.map((a) => "```\n" + formatSlackAlert(a) + "\n```")].join("\n"));
  writeOut(join(agentDir, "briefs.md"), [`# Morning briefs`, ``, ...agent.briefs.flatMap((b) => [`## ${b.clientName}: ${b.brief.headline}`, ``, b.brief.summary, ``, ...b.brief.priorities.map((p) => `- ${p.recommendationId}: ${p.why}`), ``])].join("\n"));
  writeOut(join(agentDir, "recommendations.json"), json(agent.recommendations));
  const agentTotals = agent.audit.totals();
  console.log(`Toast: ${insights.length} insights, dashboard at ${join(toastDir, "dashboard.html")}`);
  console.log(`Agent: ${agent.recommendations.length} recommendations (${agent.recommendations.filter((r) => r.risk === "human").length} need a human), ${agent.alerts.length} alerts, ${agent.actions.length} dry-run actions`);

  // Summary
  const summary = [
    `# Demo summary · ${brief.campaignName}`,
    ``,
    `Provider: **${provider.name}** · Pipeline status: **${pkg.status}**${pkg.stoppedAt ? ` (stopped at ${pkg.stoppedAt})` : ""}`,
    ``,
    `| Stage | Output | QA |`,
    `|---|---|---|`,
    `| Ideas | ${pkg.ideas.ranked.length} ranked, ${pkg.ideas.selected.length} selected | novelty/brand-fit re-scored, duplicates demoted |`,
    `| Copy | ${pkg.copy?.pack.primaryTexts.length ?? 0} primary texts, ${pkg.copy?.pack.headlines.length ?? 0} headlines | score ${pkg.copy?.validation.overall.score ?? "—"} |`,
    `| Statics | ${pkg.creatives.length} (SVG + PNG) | ${pkg.creatives.filter((c) => c.report.ok).length} pass |`,
    `| Scripts | ${pkg.scripts.length} | ${pkg.scripts.filter((s) => s.report.ok).length} pass |`,
    `| UGC | ${pkg.ugc ? `manifest, £${pkg.ugc.estimatedCostGbp} est.` : "—"} | ${pkg.ugc?.approvals.filter((a) => a.status === "approved").length ?? 0}/${pkg.ugc?.approvals.length ?? 0} gates approved |`,
    `| Video | ${pkg.video ? `${pkg.video.edl.durationSec}s EDL, ${pkg.video.edl.captions.length} cues, ${pkg.video.plan.length} ffmpeg steps` : "— (no footage)"} | ${pkg.video?.pacing.issues.length ?? 0} pacing issues |`,
    `| Landing | ${pkg.landing.length} variants | ${pkg.landing.filter((l) => l.report.ok).length} pass |`,
    `| Launch plan | ${pkg.launchPlan?.adsets.length ?? 0} ad sets | — |`,
    `| Toast | ${insights.length} insights, ${answers.length} sample answers | — |`,
    `| Agent | ${agent.recommendations.length} recommendations, ${agent.alerts.length} alerts | ${agent.actions.length} dry-run actions |`,
    ``,
    `## Cost`,
    ``,
    `Campaign package: ${totals.llmCalls} model calls, ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out tokens, **${formatUsd(totals.costUsd)}** at ${pkg.audit.byType("llm_call")[0]?.usage?.model ?? "n/a"} prices${provider.name === "mock" ? " (estimated: mock provider, no real calls)" : ""}.`,
    `Daily agent run across ${data.clients.length} clients: ${agentTotals.llmCalls} calls, **${formatUsd(agentTotals.costUsd)}**.`,
    ``,
    `By area: ${Object.entries(totals.byArea).map(([k, v]) => `${k} ${formatUsd(v)}`).join(" · ")}`,
  ].join("\n");
  writeOut(join(root, "SUMMARY.md"), summary);

  // Review queue + manifest for the web app (web/)
  const previewFor = (gate: string): { kind: string; data: unknown } => {
    switch (gate) {
      case "ideas.select":
        return { kind: "ideas", data: pkg.ideas.selected.map((i) => ({ rank: i.rank, title: i.title, angle: i.angle, hook: i.hook, total: i.total, whyItWorks: i.whyItWorks })) };
      case "copy.approve":
        return { kind: "copy", data: pkg.copy?.pack ?? {} };
      case "static.approve":
        return { kind: "creatives", data: pkg.creatives.map((c) => ({ id: c.rendered.spec.id, format: c.rendered.spec.format, layout: c.rendered.spec.layout, png: `03-creatives/${c.rendered.spec.id}.png`, score: c.report.score, ok: c.report.ok, issues: c.report.issues.map((i) => i.message) })) };
      case "scripts.approve":
        return { kind: "scripts", data: pkg.scripts.map((s) => ({ title: s.script.title, style: s.script.style, targetSeconds: s.script.targetSeconds, ok: s.report.ok, score: s.report.score, beats: s.script.beats.map((b) => ({ name: b.name, seconds: b.seconds, voiceover: b.voiceover, onScreenText: b.onScreenText })) })) };
      case "ugc.persona":
        return { kind: "ugc", data: pkg.ugc ? { persona: pkg.ugc.persona.name, synthetic: pkg.ugc.persona.synthetic, why: pkg.ugc.persona.whyThisPersona, avatar: pkg.ugc.avatar.provider, voice: pkg.ugc.voice.provider, shots: pkg.ugc.shots.length, estimatedCostGbp: pkg.ugc.estimatedCostGbp, turnaroundHours: pkg.ugc.estimatedTurnaroundHours, disclosure: pkg.ugc.disclosure.label } : {} };
      case "landing.approve":
        return { kind: "landing", data: pkg.landing.map((l) => ({ variant: l.spec.variant, html: `07-landing/variant-${l.spec.variant}.html`, headline: l.spec.hero.headline, hypothesis: l.spec.variantHypothesis, ok: l.report.ok, score: l.report.score })) };
      default:
        return { kind: "launch", data: (pkg.launchPlan?.adsets ?? []).map((a) => ({ name: a.name, placement: a.placement, dailyBudgetGbp: a.dailyBudgetGbp, ads: a.ads.length })) };
    }
  };
  writeOut(
    join(root, "review-queue.json"),
    json({
      briefId: brief.id,
      client: brief.client.name,
      campaign: brief.campaignName,
      status: pkg.status,
      quality: { meanOverall: judgement.meanOverall, verdictCounts: judgement.verdictCounts },
      cost: { llmCalls: totals.llmCalls, costUsd: totals.costUsd },
      items: pkg.gates.map((g) => ({ id: `${brief.id}:${g.gate}`, ...g, summary: reviewer.requests.find((r) => r.gate === g.gate)?.summary ?? "", preview: previewFor(g.gate) })),
    }),
  );
  const manifestPath = join(process.env.OUT_DIR ?? "out", "manifest.json");
  let manifest: { generatedAt: string; provider: string; toast: { asOf: string }; briefs: Array<{ id: string; client: string; campaign: string; dir: string }> } = { generatedAt: new Date().toISOString(), provider: provider.name, toast: { asOf }, briefs: [] };
  try {
    manifest = { ...manifest, ...(JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest), generatedAt: new Date().toISOString(), provider: provider.name, toast: { asOf } };
  } catch {
    // first run
  }
  manifest.briefs = [...manifest.briefs.filter((b) => b.id !== brief.id), { id: brief.id, client: brief.client.name, campaign: brief.campaignName, dir: brief.id }];
  writeOut(manifestPath, json(manifest));
  console.log(`\nCost (est.): campaign package ${formatUsd(totals.costUsd)} · daily agent run ${formatUsd(agentTotals.costUsd)}`);
  console.log(`\nAll outputs in ./${root} and ./out/toast, ./out/agent`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

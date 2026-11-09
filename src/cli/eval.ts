/**
 * Eval CLI: guardrail red team, pipeline scorecard, agent scenario recall.
 *   npm run eval
 * Exits non-zero if any red-team case fails or agent recall is below 100%.
 */
import { join } from "node:path";
import { formatUsd } from "../core/cost";
import { getProvider } from "../core/llm";
import { runAgentRecall, runPipelineScorecard, runRedTeam } from "../evals/suite";
import { judgePackage } from "../evals/judge";
import { runCampaignPipeline } from "../orchestrator";
import { readdirSync } from "node:fs";
import { arg, heading, json, loadBrief, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const briefPaths = arg("brief") ? [arg("brief")!] : readdirSync("samples").filter((f) => f.startsWith("brief-") && f.endsWith(".json")).map((f) => join("samples", f));
  const briefs = briefPaths.map((p) => loadBrief(p));

  heading("1. Guardrail red team");
  const red = briefs.flatMap((brief) => runRedTeam(brief).map((r) => ({ ...r, client: brief.client.name })));
  for (const r of red) console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.client.padEnd(18)} ${r.name.padEnd(26)} fired: ${r.firedRules.join(", ") || "none"}${r.missing.length ? `  MISSING: ${r.missing.join(", ")}` : ""}${r.okMismatch ? "  OK-MISMATCH" : ""}`);
  const redPass = red.filter((r) => r.passed).length;
  console.log(`\n${redPass}/${red.length} red-team cases pass across ${briefs.length} brief(s)`);

  heading("2. Pipeline scorecard");
  const scores = [];
  for (const brief of briefs) {
    const score = await runPipelineScorecard(brief, provider);
    scores.push({ client: brief.client.name, ...score });
    console.log(`\n${brief.client.name} · ${brief.campaignName}`);
    console.log(`status            ${score.status}`);
    console.log(`copy              score ${score.copyScore}/100, ${score.copyVariantsKept}/${score.copyVariantsTotal} variants kept`);
    console.log(`creatives         ${score.creativesPassing}/${score.creativesTotal} pass QA`);
    console.log(`scripts           ${score.scriptsPassing}/${score.scriptsTotal} pass QA`);
    console.log(`landing pages     ${score.landingPassing}/${score.landingTotal} pass QA`);
    console.log(`ideas             ${score.ideaAngles} distinct angles, ${score.duplicateIdeas} duplicates demoted`);
    console.log(`gates             ${score.gatesApproved}/${score.gatesTotal} approved`);
    console.log(`estimated cost    ${formatUsd(score.estimatedCostUsd)} per campaign package`);
  }

  heading("3. Media Buyer agent scenario recall");
  const recall = await runAgentRecall(provider);
  for (const d of recall.detected) console.log(`${d.found ? "FOUND " : "MISSED"} ${d.label.padEnd(20)} ${d.rule} on ${d.entityId}`);
  console.log(`\nrecall ${Math.round(recall.recall * 100)}% · ${recall.falsePositives} recommendation(s) outside the injected scenarios · ${recall.totalRecommendations} total`);

  heading("4. Creative quality · LLM-as-judge");
  const judgements = [];
  for (const brief of briefs) {
    const pkg = await runCampaignPipeline({ brief, provider });
    const judgement = await judgePackage(pkg, provider);
    judgements.push({ client: brief.client.name, ...judgement });
    console.log(`\n${brief.client.name}: mean ${judgement.meanOverall}/10 · ship ${judgement.verdictCounts.ship} · revise ${judgement.verdictCounts.revise} · reject ${judgement.verdictCounts.reject}`);
    for (const i of judgement.items) console.log(`  ${i.judgement.verdict.toUpperCase().padEnd(7)} ${i.artefactType.padEnd(8)} ${i.judgement.overall}/10  ${i.label}`);
  }
  const rejects = judgements.reduce((s, j) => s + j.verdictCounts.reject, 0);

  const dir = outDir("evals");
  writeOut(join(dir, "results.json"), json({ redTeam: red, scorecards: scores, agentRecall: recall, judgements, provider: provider.name, ranAt: new Date().toISOString() }));

  const failed = redPass !== red.length || recall.recall < 1 || scores.some((s) => s.status !== "complete") || rejects > 0;
  console.log(`\n${failed ? "EVAL FAILED" : "EVAL PASSED"} · results in ${dir}/results.json`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

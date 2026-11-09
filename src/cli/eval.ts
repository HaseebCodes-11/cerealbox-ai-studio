/**
 * Eval CLI: guardrail red team, pipeline scorecard, agent scenario recall.
 *   npm run eval
 * Exits non-zero if any red-team case fails or agent recall is below 100%.
 */
import { join } from "node:path";
import { formatUsd } from "../core/cost";
import { getProvider } from "../core/llm";
import { runAgentRecall, runPipelineScorecard, runRedTeam } from "../evals/suite";
import { arg, heading, json, loadBrief, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const brief = loadBrief(arg("brief"));

  heading("1. Guardrail red team");
  const red = runRedTeam(brief);
  for (const r of red) console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name.padEnd(26)} fired: ${r.firedRules.join(", ") || "none"}${r.missing.length ? `  MISSING: ${r.missing.join(", ")}` : ""}${r.okMismatch ? "  OK-MISMATCH" : ""}`);
  const redPass = red.filter((r) => r.passed).length;
  console.log(`\n${redPass}/${red.length} red-team cases pass`);

  heading("2. Pipeline scorecard");
  const score = await runPipelineScorecard(brief, provider);
  console.log(`status            ${score.status}`);
  console.log(`copy              score ${score.copyScore}/100, ${score.copyVariantsKept}/${score.copyVariantsTotal} variants kept`);
  console.log(`creatives         ${score.creativesPassing}/${score.creativesTotal} pass QA`);
  console.log(`scripts           ${score.scriptsPassing}/${score.scriptsTotal} pass QA`);
  console.log(`landing pages     ${score.landingPassing}/${score.landingTotal} pass QA`);
  console.log(`ideas             ${score.ideaAngles} distinct angles, ${score.duplicateIdeas} duplicates demoted`);
  console.log(`gates             ${score.gatesApproved}/${score.gatesTotal} approved`);
  console.log(`estimated cost    ${formatUsd(score.estimatedCostUsd)} per campaign package`);

  heading("3. Media Buyer agent scenario recall");
  const recall = await runAgentRecall(provider);
  for (const d of recall.detected) console.log(`${d.found ? "FOUND " : "MISSED"} ${d.label.padEnd(20)} ${d.rule} on ${d.entityId}`);
  console.log(`\nrecall ${Math.round(recall.recall * 100)}% · ${recall.falsePositives} recommendation(s) outside the injected scenarios · ${recall.totalRecommendations} total`);

  const dir = outDir("evals");
  writeOut(join(dir, "results.json"), json({ redTeam: red, scorecard: score, agentRecall: recall, provider: provider.name, ranAt: new Date().toISOString() }));

  const failed = redPass !== red.length || recall.recall < 1 || score.status !== "complete";
  console.log(`\n${failed ? "EVAL FAILED" : "EVAL PASSED"} · results in ${dir}/results.json`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

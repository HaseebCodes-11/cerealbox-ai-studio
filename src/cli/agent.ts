/**
 * Media Buyer agent CLI.
 *   npm run agent                                 # assist mode, dry run
 *   npm run agent -- --autonomy autopilot --live  # executes allowed actions against the mock ads client
 *   npm run agent -- --approve "scale-winner:hearthline-c1-as1:2026-11-08"
 */
import { join } from "node:path";
import { getProvider } from "../core/llm";
import { MockMetaAdsClient, formatSlackAlert, recommendationsToMarkdown, runMediaBuyerAgent, type AutonomyLevel } from "../areas/media-buyer";
import { generateMockDataset } from "../areas/toast";
import { arg, choiceArg, dateArg, flag, heading, json, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const asOf = dateArg("as-of", "2026-11-08");
  const autonomy = choiceArg<AutonomyLevel>("autonomy", ["assist", "copilot", "autopilot"], "assist");
  const dryRun = !flag("live");
  const approvedIds = (arg("approve") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const data = generateMockDataset({ asOf, seed: arg("seed") });
  const adsClient = new MockMetaAdsClient();

  heading(`Media Buyer agent · ${asOf} · autonomy=${autonomy} · ${dryRun ? "dry run" : "LIVE (mock ads client)"}`);
  const run = await runMediaBuyerAgent({ data, asOf, provider, adsClient, autonomy, dryRun, approvedIds });

  console.log(recommendationsToMarkdown(run.recommendations));
  console.log(`\nAlerts (${run.alerts.length}):`);
  for (const a of run.alerts) console.log(formatSlackAlert(a) + "\n");
  console.log(`Actions (${run.actions.length}):`);
  for (const a of run.actions) console.log(`- ${a.ok ? "✅" : "❌"} ${a.detail}`);
  console.log(`\nMorning briefs:`);
  for (const b of run.briefs) console.log(`- ${b.clientName}: ${b.brief.headline}`);

  const dir = outDir("agent");
  writeOut(join(dir, "recommendations.json"), json(run.recommendations));
  writeOut(join(dir, "audit.json"), json(run.audit.toJSON()));
  console.log(`\nWritten to ${dir}. Ads client calls: ${adsClient.calls.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

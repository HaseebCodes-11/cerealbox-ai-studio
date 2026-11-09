/**
 * Client reporting + client comms CLI.
 *   npm run reports    # one client-safe weekly report per client, plus drafted replies to sample client questions
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider } from "../core/llm";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../areas/media-buyer";
import { buildClientReportInput, clientReportMarkdown, clientReportTask, renderClientReport, verifyReportNumbers } from "../areas/reporting";
import { buildCommsContext, draftClientReply, draftsToMarkdown, type ClientQuestion } from "../areas/comms";
import { generateInsights, generateMockDataset } from "../areas/toast";
import { arg, heading, json, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const asOf = arg("as-of", "2026-11-08")!;
  const data = generateMockDataset({ asOf });
  const insights = generateInsights(data, asOf);
  const agent = await runMediaBuyerAgent({ data, asOf, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });

  heading(`Client reports · ${asOf}`);
  const dir = outDir("reports");
  const index: Array<{ clientId: string; clientName: string; headline: string; verified: boolean; html: string }> = [];
  for (const client of data.clients) {
    const input = buildClientReportInput(data, insights, agent.recommendations, client.id, asOf);
    const narrative = (await provider.run(clientReportTask, input)).output;
    const check = verifyReportNumbers(narrative, input);
    writeOut(join(dir, `${client.id}.html`), renderClientReport(input, narrative, check));
    writeOut(join(dir, `${client.id}.md`), clientReportMarkdown(input, narrative));
    writeOut(join(dir, `${client.id}.json`), json({ input, narrative, check }));
    index.push({ clientId: client.id, clientName: client.name, headline: narrative.headline, verified: check.ok, html: `reports/${client.id}.html` });
    console.log(`${check.ok ? "✓" : "✗"} ${client.name.padEnd(22)} ${narrative.headline}${check.ok ? "" : `  UNVERIFIED: ${check.unverified.join(", ")}`}`);
  }
  writeOut(join(dir, "index.json"), json({ asOf, reports: index }));

  heading("Client comms drafts");
  const questions = JSON.parse(readFileSync("samples/client-questions.json", "utf8")) as ClientQuestion[];
  const drafts = [];
  for (const q of questions) {
    const ctx = buildCommsContext(data, agent.recommendations, q.clientId, asOf, { contactFirstName: q.from.split(" ")[0] ?? "there", accountManager: "Haseeb", reportUrl: `https://trueroas.example/reports/${q.clientId}` });
    const draft = await draftClientReply(q, ctx, provider);
    drafts.push(draft);
    console.log(`${draft.risk === "approve" ? "APPROVE" : "HUMAN  "} ${q.clientId.padEnd(12)} ${draft.reply.category.padEnd(12)} numbers ${draft.numbers.ok ? "ok" : "UNVERIFIED"}  ${q.text.slice(0, 60)}`);
  }
  const commsDir = outDir("comms");
  writeOut(join(commsDir, "replies.md"), `# Drafted client replies · ${asOf}\n\n${draftsToMarkdown(drafts)}`);
  writeOut(join(commsDir, "replies.json"), json(drafts));
  console.log(`\nReports: ${dir} · Comms: ${commsDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

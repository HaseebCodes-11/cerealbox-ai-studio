/**
 * Toast CLI.
 *   npm run toast                               # build dashboard + insights to out/toast
 *   npm run toast:ask -- "Which client had the biggest ROAS drop?"
 */
import { join } from "node:path";
import { getProvider } from "../core/llm";
import { askToast, generateInsights, generateMockDataset, insightsToMarkdown, narrativeTask, renderDashboard } from "../areas/toast";
import { arg, dateArg, heading, json, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const asOf = dateArg("as-of", "2026-11-08");
  const data = generateMockDataset({ asOf, seed: arg("seed") });
  const [, , command, ...rest] = process.argv;

  if (command === "ask") {
    const question = rest.filter((r) => !r.startsWith("--")).join(" ") || "Which client had the biggest ROAS drop last week?";
    const answer = await askToast(question, data, asOf, provider);
    heading(`Ask Toast · ${question}`);
    console.log(answer.text);
    if (answer.table) {
      console.log("");
      console.log(answer.table.columns.join(" | "));
      for (const row of answer.table.rows) console.log(row.join(" | "));
    }
    console.log(`\n(intent: ${answer.intent.intent}, metric: ${answer.intent.metric}, ${answer.intent.days} days · sources: ${answer.sources.join(", ")})`);
    return;
  }

  heading(`Toast · building dashboard for ${asOf}`);
  const insights = generateInsights(data, asOf);
  const narrative = (await provider.run(narrativeTask, { asOf, days: 7, insights })).output;
  const dir = outDir("toast");
  writeOut(join(dir, "dashboard.html"), renderDashboard({ data, asOf, insights, narrative }));
  writeOut(join(dir, "insights.md"), [`# Toast insights · ${asOf}`, ``, `## ${narrative.headline}`, ``, ...narrative.paragraphs, ``, insightsToMarkdown(insights)].join("\n"));
  writeOut(join(dir, "dataset.json"), json(data));
  console.log(insightsToMarkdown(insights));
  console.log(`\nDashboard: ${join(dir, "dashboard.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

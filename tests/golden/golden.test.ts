/**
 * Golden-output guards.
 *
 * Every deterministic artefact the system produces for the sample inputs is
 * captured once (UPDATE_GOLDEN=1 npx vitest run tests/golden) and compared on
 * every later run. Any refactor, performance change or dependency bump that
 * alters a single character of generated copy, HTML, SVG, EDL, launch payload,
 * recommendation or guardrail verdict fails here with a readable diff.
 *
 * Non-deterministic fields (latency, wall-clock timestamps) are stripped;
 * large binary/text blobs (PNG, SVG, HTML) are compared by SHA-256 so the
 * fixtures stay small while still pinning the exact bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLog } from "../../src/core/audit";
import { parseBrief } from "../../src/core/brief";
import { MockProvider } from "../../src/core/llm";
import { RecordingReviewer } from "../../src/core/review";
import { buildMetaLaunchBundle, MockMetaAdsClient, runMediaBuyerAgent } from "../../src/areas/media-buyer";
import { askToast, generateInsights, generateMockDataset, narrativeTask, renderDashboard } from "../../src/areas/toast";
import { buildClientReportInput, clientReportTask, renderClientReport, verifyReportNumbers } from "../../src/areas/reporting";
import { buildCommsContext, draftClientReply, type ClientQuestion } from "../../src/areas/comms";
import { runRedTeam, runPipelineScorecard, runAgentRecall } from "../../src/evals/suite";
import { judgePackage } from "../../src/evals/judge";
import { runCampaignPipeline } from "../../src/orchestrator";
import { RawClipSchema } from "../../src/areas/video";

const FIXTURES = join(__dirname, "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const AS_OF = "2026-11-08";
const CLOCK = () => new Date("2026-11-08T09:00:00.000Z");

const STRIP_KEYS = new Set(["latencyMs", "at", "generatedAt", "ms"]);

function sha(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Deep-normalise: drop timing keys, hash long strings and byte arrays. */
function normalise(value: unknown, key = ""): unknown {
  if (value instanceof Uint8Array) return sha(value);
  if (Array.isArray(value)) return value.map((v) => normalise(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = normalise(v, k);
    }
    return out;
  }
  if (typeof value === "string" && (value.length > 2000 || /^(html|svg|srt)$/.test(key))) return sha(value);
  return value;
}

function compare(name: string, value: unknown): void {
  const path = join(FIXTURES, `${name}.json`);
  const actual = JSON.stringify(normalise(value), null, 2) + "\n";
  if (UPDATE || !existsSync(path)) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  const expected = readFileSync(path, "utf8");
  if (expected !== actual) {
    // Pretty diff via vitest's object comparison rather than a wall of text.
    expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
  }
}

const briefs = readdirSync("samples")
  .filter((f) => f.startsWith("brief-") && f.endsWith(".json"))
  .sort()
  .map((f) => parseBrief(JSON.parse(readFileSync(join("samples", f), "utf8"))));
const clips = z.array(RawClipSchema).parse(JSON.parse(readFileSync("samples/raw-clips.json", "utf8")));
const questions = JSON.parse(readFileSync("samples/client-questions.json", "utf8")) as ClientQuestion[];

describe("golden outputs", () => {
  for (const brief of briefs) {
    it(`campaign pipeline · ${brief.id}`, async () => {
      const provider = new MockProvider();
      const audit = new AuditLog(CLOCK);
      const reviewer = new RecordingReviewer();
      const pkg = await runCampaignPipeline({ brief, provider, reviewer, clips, audit, today: AS_OF });
      const judgement = await judgePackage(pkg, provider);
      const launch = pkg.launchPlan && pkg.copy ? buildMetaLaunchBundle(pkg.launchPlan, brief, pkg.copy.pack, { adAccountId: "act_<client>", pageId: "<page_id>", pixelId: "<pixel_id>", landingBaseUrl: `https://give.${brief.client.id}.example` }) : null;
      compare(`pipeline-${brief.id}`, { pkg, judgement, launch, audit: { events: audit.all(), totals: audit.totals() }, reviews: reviewer.requests.map((r) => ({ gate: r.gate, area: r.area, risk: r.risk })) });
    }, 60_000);
  }

  it("toast · dataset, insights, narrative, dashboard, Ask Toast", async () => {
    const provider = new MockProvider();
    const data = generateMockDataset({ asOf: AS_OF });
    const insights = generateInsights(data, AS_OF);
    const narrative = (await provider.run(narrativeTask, { asOf: AS_OF, days: 7, insights })).output;
    const agent = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy: "copilot", dryRun: true });
    const asks = ["Which client had the biggest ROAS drop last week?", "How is Hearthline doing?", "Do video or static creatives perform better?", "Anything unusual this week?", "How much did we spend in total last 28 days?", "Compare Hearthline and Paws & Place", "What is the meaning of life?"];
    const answers = [];
    for (const q of asks) answers.push(await askToast(q, data, AS_OF, provider));
    const dashboard = renderDashboard({ data, asOf: AS_OF, insights, narrative, recommendations: agent.recommendations, sampleAnswers: answers });
    compare("toast", { dataset: sha(JSON.stringify(data)), rows: data.metrics.length, insights, narrative, answers, dashboard: sha(dashboard), agent });
  });

  it("media buyer agent · every autonomy level", async () => {
    const provider = new MockProvider();
    const data = generateMockDataset({ asOf: AS_OF });
    const runs: Record<string, unknown> = {};
    for (const autonomy of ["assist", "copilot", "autopilot"] as const) {
      for (const dryRun of [true, false]) {
        const run = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy, dryRun });
        runs[`${autonomy}-${dryRun ? "dry" : "live"}`] = run;
      }
    }
    compare("agent", runs);
  });

  it("client reports and comms drafts", async () => {
    const provider = new MockProvider();
    const data = generateMockDataset({ asOf: AS_OF });
    const insights = generateInsights(data, AS_OF);
    const agent = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
    const reports = [];
    for (const client of data.clients) {
      const input = buildClientReportInput(data, insights, agent.recommendations, client.id, AS_OF);
      const narrative = (await provider.run(clientReportTask, input)).output;
      const check = verifyReportNumbers(narrative, input);
      reports.push({ client: client.id, input, narrative, check, html: renderClientReport(input, narrative, check) });
    }
    const drafts = [];
    for (const q of questions) {
      const ctx = buildCommsContext(data, agent.recommendations, q.clientId, AS_OF, { contactFirstName: q.from.split(" ")[0] ?? "there", accountManager: "Haseeb", reportUrl: `https://trueroas.example/reports/${q.clientId}` });
      drafts.push(await draftClientReply(q, ctx, provider));
    }
    compare("reports-comms", { reports, drafts });
  });

  it("evals · red team, scorecard, agent recall", async () => {
    const provider = new MockProvider();
    const red = briefs.flatMap((brief) => runRedTeam(brief).map((r) => ({ ...r, client: brief.client.name })));
    const scorecards = [];
    for (const brief of briefs) scorecards.push(await runPipelineScorecard(brief, provider));
    const recall = await runAgentRecall(provider);
    compare("evals", { red, scorecards, recall });
  }, 60_000);
});

/**
 * Second production-breakage pass · client reports and comms drafts.
 */
import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/core/llm";
import { generateInsights, generateMockDataset } from "../../src/areas/toast";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../../src/areas/media-buyer";
import { buildClientReportInput, clientReportTask, renderClientReport, verifyReportNumbers, type ClientReportInput } from "../../src/areas/reporting";
import { buildCommsContext, categorise, draftClientReply } from "../../src/areas/comms";

const AS_OF = "2026-11-08";
const data = generateMockDataset({ asOf: AS_OF });
const provider = new MockProvider();

async function reportInput(clientId = "hearthline"): Promise<ClientReportInput> {
  const insights = generateInsights(data, AS_OF);
  const agent = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
  return buildClientReportInput(data, insights, agent.recommendations, clientId, AS_OF);
}

describe("O1 · reports for awkward weeks", () => {
  it.fails("[BUG2-45] a week with spend but no donations never tells the client each donation 'cost £0'", async () => {
    const input = { ...(await reportInput()), current: { spend: 420, revenue: 0, roas: 0, conversions: 0, cpa: 0, avgGift: 0 } };
    const narrative = (await provider.run(clientReportTask, input)).output;
    const text = [narrative.headline, ...narrative.summary, ...narrative.highlights, ...narrative.concerns].join(" ");
    expect(text).not.toMatch(/cost £0 to acquire|average gift was £0|each donation cost £0/);
    expect(text.toLowerCase()).toMatch(/no donations|did not (bring|result)|without a donation/);
  });

  it.fails("[BUG2-46] the change column shows n/a, not 0%, when there is no previous period", async () => {
    const input = { ...(await reportInput()), previous: { spend: 0, revenue: 0, roas: 0, conversions: 0, cpa: 0, avgGift: 0 } };
    const narrative = (await provider.run(clientReportTask, input)).output;
    const html = renderClientReport(input, narrative, verifyReportNumbers(narrative, input));
    const changeCells = [...html.matchAll(/<td class="num[^"]*">([^<]*)<\/td><\/tr>/g)].map((m) => m[1]);
    expect(changeCells.length).toBeGreaterThan(0);
    for (const cell of changeCells) expect(cell).not.toBe("0%");
  });

  it.fails("[BUG2-47] a year written in prose is not an unverified figure", async () => {
    const input = await reportInput();
    const narrative = (await provider.run(clientReportTask, input)).output;
    narrative.summary = [`${narrative.summary[0]} This is the strongest November since 2024.`];
    const check = verifyReportNumbers(narrative, input);
    expect(check.unverified).not.toContain("2024");
  });

  it("a figure that is not in the data is still caught", async () => {
    const input = await reportInput();
    const narrative = (await provider.run(clientReportTask, input)).output;
    narrative.highlights = ["We reached 48,912 people."];
    expect(verifyReportNumbers(narrative, input).unverified).toContain("48912");
  });
});

describe("O2 · emails as clients write them", () => {
  const context = async (clientId = "hearthline", contactFirstName = "Sam") => {
    const agent = await runMediaBuyerAgent({ data, asOf: AS_OF, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
    return buildCommsContext(data, agent.recommendations, clientId, AS_OF, { contactFirstName, accountManager: "Haseeb" });
  };

  it("a signature containing 'Invoicing' does not turn a performance question into a billing escalation", () => {
    const text = "Hi, how are the ads performing this week?\n\nThanks,\nJane Smith\nHead of Finance & Invoicing\nHearthline";
    expect(categorise(text)).toBe("performance");
  });

  it("a request to pause over Christmas is escalated to a human rather than answered with numbers", async () => {
    const ctx = await context();
    const draft = await draftClientReply({ id: "q", clientId: "hearthline", from: "Sam", receivedAt: AS_OF, text: "Can we pause the ads over Christmas week and restart in January?" }, ctx, provider);
    expect(draft.risk).toBe("human");
    expect(draft.reply.needsHumanInput).toBe(true);
  });

  it.fails("[BUG2-48] an empty sender name still produces a proper greeting", async () => {
    const ctx = await context("hearthline", "");
    const draft = await draftClientReply({ id: "q", clientId: "hearthline", from: "", receivedAt: AS_OF, text: "How are we doing?" }, ctx, provider);
    expect(draft.reply.reply).not.toMatch(/^Hi ,/);
  });

  it("a 10,000-character email produces a subject under the schema limit and a reply", async () => {
    const ctx = await context();
    const text = `How are the ads performing? ${"Context. ".repeat(1200)}`;
    const draft = await draftClientReply({ id: "q", clientId: "hearthline", from: "Sam", receivedAt: AS_OF, text }, ctx, provider);
    expect(draft.reply.subject.length).toBeLessThanOrEqual(120);
    expect(draft.reply.reply.length).toBeGreaterThan(20);
  });

  it("every number in a data-backed reply traces to the context, including decimals in the return", async () => {
    const ctx = await context();
    ctx.figures.roas = 3.14;
    const draft = await draftClientReply({ id: "q", clientId: "hearthline", from: "Sam", receivedAt: AS_OF, text: "What are the results this week?" }, ctx, provider);
    expect(draft.numbers.ok).toBe(true);
  });
});

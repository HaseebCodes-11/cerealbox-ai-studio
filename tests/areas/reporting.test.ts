import { describe, expect, it } from "vitest";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../../src/areas/media-buyer";
import { ClientReportNarrativeSchema, buildClientReportInput, clientReportMarkdown, clientReportTask, numbersIn, renderClientReport, verifyReportNumbers } from "../../src/areas/reporting";
import { generateInsights, generateMockDataset } from "../../src/areas/toast";
import { provider } from "../helpers";

const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const insights = generateInsights(data, asOf);
const agent = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });

describe("client report input", () => {
  it("computes figures, audiences, top creative and client-safe actions per client", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "hearthline", asOf);
    expect(input.clientName).toBe("Hearthline");
    expect(input.current.revenue).toBeGreaterThan(0);
    expect(input.adsets).toHaveLength(2);
    expect(input.topCreative).not.toBeNull();
    expect(input.actions.every((a) => !/CPA|ROAS|ad set|learning limited/i.test(a))).toBe(true);
    expect(input.actions.some((a) => /increasing its budget/.test(a))).toBe(true);
    expect(input.insights.every((i) => i.title.includes("Hearthline") || i.title.includes("WW"))).toBe(true);
    expect(() => buildClientReportInput(data, insights, agent.recommendations, "nope", asOf)).toThrow(/Unknown client/);
  });

  it("translates a tracking break into a client-safe action", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "bluewater", asOf);
    expect(input.actions.some((a) => /tracking issue/.test(a))).toBe(true);
    expect(input.insights.some((i) => i.severity === "critical")).toBe(true);
  });
});

describe("narrative and number verification", () => {
  it("produces a schema-valid narrative for every client whose numbers all verify", async () => {
    for (const client of data.clients) {
      const input = buildClientReportInput(data, insights, agent.recommendations, client.id, asOf);
      const narrative = (await provider().run(clientReportTask, input)).output;
      expect(ClientReportNarrativeSchema.safeParse(narrative).success).toBe(true);
      const check = verifyReportNumbers(narrative, input);
      expect(check.ok, `${client.name}: ${check.unverified.join(", ")}`).toBe(true);
      expect(check.checked).toBeGreaterThan(5);
      expect(narrative.headline).not.toMatch(/\.\d{2}\b/);
    }
  });

  it("catches an invented number", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "hearthline", asOf);
    const narrative = { headline: "Great week", summary: ["You raised £99,999 from 12,345 donations."], highlights: [], concerns: [], nextSteps: ["Keep going."] };
    const check = verifyReportNumbers(narrative, input);
    expect(check.ok).toBe(false);
    expect(check.unverified).toEqual(expect.arrayContaining(["99999", "12345"]));
  });

  it("accepts rounded and comma-formatted forms of real figures", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "hearthline", asOf);
    const revenue = Math.round(input.current.revenue).toLocaleString("en-GB");
    const narrative = { headline: `£${revenue} raised`, summary: [`Return ${input.current.roas}x against ${input.targetRoas}x over ${input.days} days to ${asOf}.`], highlights: [], concerns: [], nextSteps: ["x"] };
    expect(verifyReportNumbers(narrative, input).ok).toBe(true);
    expect(numbersIn("£5,853.23 and 4,200 people, 7 days")).toEqual(["5853.23", "4200", "7"]);
  });

  it("the prompt uses plain-English labels and includes the figures", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "hearthline", asOf);
    const prompt = clientReportTask.prompt(input);
    expect(prompt).toContain("cost per donation");
    expect(prompt).toContain(`£${input.current.spend}`);
    expect(prompt).not.toMatch(/\bCPA\b/);
  });
});

describe("rendering", () => {
  it("renders an escaped, self-contained HTML report and a markdown version", async () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "kindred", asOf);
    const narrative = (await provider().run(clientReportTask, input)).output;
    const check = verifyReportNumbers(narrative, input);
    const html = renderClientReport({ ...input, clientName: "Kindred <Kitchens>" }, narrative, check);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Kindred &lt;Kitchens&gt;");
    expect(html).toContain("All");
    expect(html).toContain("figures verified against the data");
    expect(html).toContain("By audience");
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThan(input.adsets.length + 4);
    expect(html).not.toContain("<script");
    const md = clientReportMarkdown(input, narrative);
    expect(md.startsWith(`# ${narrative.headline}`)).toBe(true);
    expect(md).toContain("| Raised |");
    expect(md).toContain("**What happens next**");
  });

  it("shows a review flag when numbers do not verify", () => {
    const input = buildClientReportInput(data, insights, agent.recommendations, "kindred", asOf);
    const html = renderClientReport(input, { headline: "h", summary: ["s"], highlights: [], concerns: [], nextSteps: ["n"] }, { ok: false, unverified: ["99"], checked: 3 });
    expect(html).toContain("1 figure(s) need review");
  });
});

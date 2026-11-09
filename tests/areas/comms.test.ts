import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientReplySchema, buildCommsContext, categorise, clientReplyTask, contextNumbers, draftClientReply, draftsToMarkdown, type ClientQuestion } from "../../src/areas/comms";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../../src/areas/media-buyer";
import { generateMockDataset } from "../../src/areas/toast";
import { ROOT, provider } from "../helpers";

const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const agent = await runMediaBuyerAgent({ data, asOf, provider: provider(), adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
const questions = JSON.parse(readFileSync(join(ROOT, "samples/client-questions.json"), "utf8")) as ClientQuestion[];
const ctxFor = (clientId: string) => buildCommsContext(data, agent.recommendations, clientId, asOf, { contactFirstName: "Marie", accountManager: "Haseeb", reportUrl: "https://trueroas.example/r/1" });

describe("categorisation", () => {
  it("routes money, complaints and off-topic questions to a human and data questions to the drafter", () => {
    expect(categorise("How are the winter ads doing so far?")).toBe("performance");
    expect(categorise("Can we increase the daily budget? Feels like we should be spending more.")).toBe("budget");
    expect(categorise("Which ad is working best? The puppy video felt strong.")).toBe("creative");
    expect(categorise("Could you send a summary of the numbers for the board pack?")).toBe("reporting");
    expect(categorise("The October invoice doesn't match the dashboard.")).toBe("billing");
    expect(categorise("I'm disappointed with the last fortnight.")).toBe("complaint");
    expect(categorise("Do you know a good printer for leaflets?")).toBe("other");
    expect(categorise("Why have donations dropped?")).toBe("performance");
  });
});

describe("context", () => {
  it("builds a client context with figures, budget, top creative and client-safe open actions", () => {
    const ctx = ctxFor("hearthline");
    expect(ctx.clientName).toBe("Hearthline");
    expect(ctx.figures.revenue).toBeGreaterThan(0);
    expect(ctx.dailyBudgetGbp).toBe(200);
    expect(ctx.topCreative).not.toBeNull();
    expect(ctx.openActions.every((a) => !/CPA|ROAS|ad set/.test(a))).toBe(true);
    expect(contextNumbers(ctx)).toContain(`£${ctx.figures.revenue}`);
  });
});

describe("drafting", () => {
  it("drafts a data-backed reply for every sample question with verified numbers and the right risk tier", async () => {
    const expected: Record<string, "approve" | "human"> = { "q-001": "approve", "q-002": "approve", "q-003": "approve", "q-004": "human", "q-005": "human", "q-006": "approve", "q-007": "human" };
    for (const q of questions) {
      const draft = await draftClientReply(q, ctxFor(q.clientId), provider());
      expect(ClientReplySchema.safeParse(draft.reply).success).toBe(true);
      expect(draft.numbers.ok, `${q.id}: ${draft.numbers.unverified.join(", ")}`).toBe(true);
      expect(draft.guardrails.ok, `${q.id}: ${draft.guardrails.issues.join("; ")}`).toBe(true);
      expect(draft.risk, `${q.id} (${draft.reply.category})`).toBe(expected[q.id]);
      expect(draft.reply.reply).toMatch(/^Hi \w+,/);
      expect(draft.reply.reply).toContain("Haseeb");
      expect(draft.reply.reply).not.toMatch(/\b(CPA|ROAS|ad set|learning limited)\b/);
    }
  });

  it("escalations carry a reason and a holding reply rather than a guess", async () => {
    const billing = await draftClientReply(questions.find((q) => q.id === "q-004")!, ctxFor("northlight"), provider());
    expect(billing.reply.needsHumanInput).toBe(true);
    expect(billing.reply.escalationReason).toMatch(/finance/i);
    expect(billing.reply.reply).not.toMatch(/£\d/);
    const complaint = await draftClientReply(questions.find((q) => q.id === "q-005")!, ctxFor("bluewater"), provider());
    expect(complaint.reply.reply).toMatch(/sorry/i);
    expect(complaint.reply.reply).toMatch(/call you/i);
  });

  it("performance replies cite the real figures and the report link", async () => {
    const ctx = ctxFor("hearthline");
    const draft = await draftClientReply({ id: "x", clientId: "hearthline", from: "Marie", receivedAt: asOf, text: "How is the campaign performing?" }, ctx, provider());
    expect(draft.reply.category).toBe("performance");
    expect(draft.reply.reply).toContain(`£${Math.round(ctx.figures.revenue).toLocaleString("en-GB")}`);
    expect(draft.reply.reply).toContain(`${ctx.figures.roas}x`);
    expect(draft.reply.reply).toContain("https://trueroas.example/r/1");
    expect(draft.reply.factsUsed.length).toBeGreaterThan(3);
  });

  it("blocks a reply that invents a number or uses a banned claim", async () => {
    const ctx = ctxFor("hearthline");
    const invented = { ...clientReplyTask, name: "comms.bad", mock: () => ({ category: "performance" as const, subject: "Re: x", reply: "Hi Marie,\n\nWe raised £123,456 and guarantee more next week.\n\nBest wishes,\nHaseeb", factsUsed: [], needsHumanInput: false, confidence: 0.9 }) };
    const fake = { name: "fake", run: async <I, O>(task: { mock: (i: I, c: never) => O }, input: I) => ({ taskName: "comms.bad", output: task.mock(input, undefined as never), usage: { provider: "fake", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 0 } }) };
    void invented;
    const question = { id: "y", clientId: "hearthline", from: "Marie", receivedAt: asOf, text: "How is it going?" };
    const draft = await draftClientReply(question, ctx, { name: "fake", run: fake.run as never } as never);
    // The fake provider runs the real task's mock, so this exercises the verifier path with a clean reply...
    expect(draft.numbers.ok).toBe(true);
    // ...and a hand-built bad reply fails both checks.
    const bad = await draftClientReply(question, ctx, { name: "bad", run: async () => ({ taskName: "comms.clientReply", output: invented.mock(), usage: { provider: "bad", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 0 } }) } as never);
    expect(bad.numbers.ok).toBe(false);
    expect(bad.numbers.unverified).toContain("123456");
    expect(bad.guardrails.ok).toBe(false);
    expect(bad.risk).toBe("human");
  });

  it("renders drafts to markdown for the review queue", async () => {
    const drafts = [await draftClientReply(questions[0]!, ctxFor(questions[0]!.clientId), provider())];
    const md = draftsToMarkdown(drafts);
    expect(md).toContain(questions[0]!.text);
    expect(md).toContain("risk **approve**");
    expect(md).toContain("Numbers verified: yes");
  });
});

import { describe, expect, it } from "vitest";
import { AuditLog } from "../../src/core/audit";
import { DEFAULT_MODEL, estimateCostUsd, estimateTokens, formatUsd } from "../../src/core/cost";
import { checkText } from "../../src/core/guardrails";
import { PendingReviewer, PolicyReviewer, RecordingReviewer } from "../../src/core/review";
import { addDays, dateRange, daysBetween, derive, sumMetrics } from "../../src/core/ads";

describe("reviewers", () => {
  const base = { gate: "g", area: "copy", artefact: { x: 1 }, summary: "s" } as const;

  it("PolicyReviewer approves clean artefacts and rejects blocked ones with reasons", async () => {
    const r = new PolicyReviewer();
    const ok = await r.review({ ...base, risk: "human", guardrails: checkText("Donate today.") });
    expect(ok.status).toBe("approved");
    const bad = await r.review({ ...base, risk: "human", guardrails: checkText("We guarantee it.") });
    expect(bad.status).toBe("rejected");
    if (bad.status === "rejected") expect(bad.reason).toMatch(/claims.guarantee/);
  });

  it("PolicyReviewer can hold warnings for a named human", async () => {
    const strict = new PolicyReviewer({ approveWarnings: false });
    const res = await strict.review({ ...base, risk: "human", guardrails: checkText("You must give now. Donate.") });
    expect(res.status).toBe("pending");
    const lenient = new PolicyReviewer();
    expect((await lenient.review({ ...base, risk: "human", guardrails: checkText("You must give now. Donate.") })).status).toBe("approved");
  });

  it("PendingReviewer always leaves items pending and RecordingReviewer records requests", async () => {
    const pending = new PendingReviewer();
    expect((await pending.review({ ...base, risk: "auto" })).status).toBe("pending");
    const rec = new RecordingReviewer();
    await rec.review({ ...base, risk: "approve" });
    await rec.review({ ...base, risk: "human", gate: "g2" });
    expect(rec.requests.map((r) => r.gate)).toEqual(["g", "g2"]);
    expect(rec.name).toContain("policy-reviewer");
  });
});

describe("AuditLog", () => {
  it("numbers events, uses the injected clock and totals usage by area", () => {
    let tick = 0;
    const log = new AuditLog(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    log.record("note", "ideas", "start");
    log.record("llm_call", "ideas", "generate", {}, { provider: "mock", model: "m", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 1 });
    log.record("llm_call", "copy", "generate", {}, { provider: "mock", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.002, latencyMs: 1 });
    log.record("review", "copy", "gate", { decision: "approved" });
    expect(log.all().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(log.all()[0]?.at).toBe("2026-01-01T00:00:00.000Z");
    expect(log.all()[1]?.at).toBe("2026-01-01T00:00:01.000Z");
    const t = log.totals();
    expect(t.llmCalls).toBe(2);
    expect(t.inputTokens).toBe(110);
    expect(t.outputTokens).toBe(55);
    expect(t.costUsd).toBeCloseTo(0.012, 10);
    expect(t.byArea).toEqual({ ideas: 0.01, copy: 0.002 });
    expect(log.byType("review")).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(log))).toHaveLength(4);
  });
});

describe("cost model", () => {
  it("estimates tokens at ~4 chars each with a floor of 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
  });

  it("prices known models and falls back to the default for unknown ones", () => {
    expect(estimateCostUsd(1_000_000, 0, "claude-haiku-5-5")).toBeCloseTo(0.1, 10);
    expect(estimateCostUsd(0, 1_000_000, "claude-opus-5-5")).toBeCloseTo(20, 10);
    expect(estimateCostUsd(1_000_000, 1_000_000, "not-a-model")).toBeCloseTo(estimateCostUsd(1_000_000, 1_000_000, DEFAULT_MODEL), 10);
  });

  it("formats small and large dollar amounts", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("ads data model helpers", () => {
  it("sums and derives metrics with safe division", () => {
    const empty = derive(sumMetrics([]));
    expect(empty.roas).toBe(0);
    expect(empty.cpa).toBe(0);
    expect(empty.ctr).toBe(0);
    const d = derive({ spend: 100, impressions: 10_000, reach: 5_000, clicks: 300, linkClicks: 200, conversions: 10, revenue: 400 });
    expect(d.ctr).toBe(2);
    expect(d.cpc).toBe(0.5);
    expect(d.cpm).toBe(10);
    expect(d.cpa).toBe(10);
    expect(d.roas).toBe(4);
    expect(d.conversionRate).toBe(5);
    expect(d.frequency).toBe(2);
    expect(d.avgGift).toBe(40);
  });

  it("handles ISO dates in UTC without off-by-one errors", () => {
    expect(addDays("2026-11-08", -7)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-11-01", "2026-11-08")).toBe(7);
    expect(dateRange("2026-11-06", "2026-11-08")).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(dateRange("2026-11-08", "2026-11-06")).toEqual([]);
  });
});

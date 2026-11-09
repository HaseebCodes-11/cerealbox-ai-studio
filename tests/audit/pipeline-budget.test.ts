import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../../src/core/audit";
import { parseBrief } from "../../src/core/brief";
import { MockProvider } from "../../src/core/llm";
import { runCampaignPipeline } from "../../src/orchestrator";

const brief = parseBrief(JSON.parse(readFileSync("samples/brief-winter-warmth.json", "utf8")));
const clock = () => new Date("2026-11-08T09:00:00Z");
const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (k, v) => (k === "latencyMs" ? undefined : v)));

describe("pipeline budget guard (COST-04)", () => {
  it("is a no-op when no budget is set or the budget is not reached", async () => {
    const a = await runCampaignPipeline({ brief, provider: new MockProvider(), audit: new AuditLog(clock), today: "2026-11-08" });
    const b = await runCampaignPipeline({ brief, provider: new MockProvider(), audit: new AuditLog(clock), today: "2026-11-08", budgetUsd: 100 });
    expect(a.status).toBe("complete");
    expect(strip({ ...b, audit: b.audit.all() })).toEqual(strip({ ...a, audit: a.audit.all() }));
  });

  it("stops at the next gate once estimated spend exceeds the budget, and says so", async () => {
    const audit = new AuditLog(clock);
    const pkg = await runCampaignPipeline({ brief, provider: new MockProvider(), audit, today: "2026-11-08", budgetUsd: 0.03 });
    expect(pkg.status).toBe("blocked");
    expect(pkg.stoppedAt).toBe("budget");
    const budgetGate = pkg.gates.find((g) => g.reviewer === "budget");
    expect(budgetGate).toBeDefined();
    expect(budgetGate!.decision).toBe("rejected");
    expect(budgetGate!.reason).toMatch(/exceeded the \$0\.03 budget before/);
    expect(audit.totals().costUsd).toBeGreaterThan(0.03);
    expect(audit.totals().costUsd).toBeLessThan(0.17); // the full run costs ~$0.17; we stopped well before the end
    expect(audit.byType("error")).toHaveLength(1);
    // Work already produced is kept for the reviewer; nothing after the stop was attempted.
    expect(pkg.ideas.ranked.length).toBeGreaterThan(0);
    expect(pkg.launchPlan).toBeNull();
  });

  it("a zero budget stops at the very first gate", async () => {
    const pkg = await runCampaignPipeline({ brief, provider: new MockProvider(), budgetUsd: 0 });
    expect(pkg.stoppedAt).toBe("budget");
    expect(pkg.gates).toHaveLength(1);
    expect(pkg.gates[0]!.gate).toBe("ideas.select");
  });
});

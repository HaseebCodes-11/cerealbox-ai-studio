import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit";
import { PendingReviewer, PolicyReviewer, RecordingReviewer, type ReviewDecision, type ReviewRequest, type Reviewer } from "../src/core/review";
import { buildLaunchPlan, runCampaignPipeline } from "../src/orchestrator";
import { provider, sampleBrief, sampleClips, sampleCopy, sampleIdea } from "./helpers";

const brief = sampleBrief();

describe("campaign pipeline", () => {
  it("runs every stage to completion with footage supplied", async () => {
    const reviewer = new RecordingReviewer();
    const pkg = await runCampaignPipeline({ brief, provider: provider(), reviewer, clips: sampleClips() });
    expect(pkg.status).toBe("complete");
    expect(pkg.stoppedAt).toBeUndefined();
    expect(pkg.gates.map((g) => g.gate)).toEqual(["ideas.select", "copy.approve", "static.approve", "scripts.approve", "ugc.persona", "landing.approve", "launch.approve"]);
    expect(pkg.gates.every((g) => g.decision === "approved")).toBe(true);
    expect(reviewer.requests).toHaveLength(7);
    expect(pkg.ideas.ranked.length).toBe(10);
    expect(pkg.ideas.selected.length).toBeGreaterThanOrEqual(3);
    expect(pkg.copy?.validation.overall.ok).toBe(true);
    expect(pkg.creatives).toHaveLength(3);
    expect(pkg.creatives.every((c) => c.report.ok)).toBe(true);
    expect(pkg.scripts).toHaveLength(3);
    expect(pkg.scripts.every((s) => s.report.ok)).toBe(true);
    expect(pkg.ugc?.scriptId).toContain("ugc-testimonial");
    expect(pkg.video?.edl.captions.length).toBeGreaterThan(0);
    expect(pkg.video?.unmatchedBeats).toEqual([]);
    expect(pkg.landing).toHaveLength(2);
    expect(pkg.landing.every((l) => l.report.ok)).toBe(true);
    expect(pkg.landingDiff.length).toBeGreaterThan(0);
    expect(pkg.launchPlan?.adsets).toHaveLength(6);
  });

  it("skips the video stage when no footage is supplied", async () => {
    const pkg = await runCampaignPipeline({ brief, provider: provider() });
    expect(pkg.status).toBe("complete");
    expect(pkg.video).toBeNull();
    expect(pkg.ugc).not.toBeNull();
  });

  it("stops at the first gate when the reviewer leaves it pending", async () => {
    const pkg = await runCampaignPipeline({ brief, provider: provider(), reviewer: new PendingReviewer() });
    expect(pkg.status).toBe("awaiting_review");
    expect(pkg.stoppedAt).toBe("ideas.select");
    expect(pkg.ideas.selected.length).toBeGreaterThan(0);
    expect(pkg.copy).toBeNull();
    expect(pkg.creatives).toEqual([]);
    expect(pkg.gates).toHaveLength(1);
    expect(pkg.gates[0]!.decision).toBe("pending");
  });

  it("stops with status blocked when a reviewer rejects a later gate", async () => {
    class RejectCopy implements Reviewer {
      readonly name = "reject-copy";
      async review<T>(req: ReviewRequest<T>): Promise<ReviewDecision<T>> {
        if (req.gate === "copy.approve") return { status: "rejected", reviewer: this.name, reason: "Tone is off" };
        return { status: "approved", artefact: req.artefact, reviewer: this.name };
      }
    }
    const pkg = await runCampaignPipeline({ brief, provider: provider(), reviewer: new RejectCopy() });
    expect(pkg.status).toBe("blocked");
    expect(pkg.stoppedAt).toBe("copy.approve");
    expect(pkg.copy).not.toBeNull();
    expect(pkg.creatives).toEqual([]);
    expect(pkg.gates.find((g) => g.gate === "copy.approve")?.reason).toBe("Tone is off");
  });

  it("writes an audit trail with per-area costs and review records", async () => {
    const audit = new AuditLog();
    const pkg = await runCampaignPipeline({ brief, provider: provider(), audit, clips: sampleClips() });
    const totals = pkg.audit.totals();
    expect(pkg.audit).toBe(audit);
    expect(totals.llmCalls).toBe(8);
    expect(Object.keys(totals.byArea).sort()).toEqual(["copy", "ideas", "landing", "scripts", "static", "ugc", "video"]);
    expect(totals.costUsd).toBeGreaterThan(0);
    expect(totals.costUsd).toBeLessThan(1);
    expect(audit.byType("review")).toHaveLength(7);
    expect(audit.byType("render")).toHaveLength(3);
    expect(audit.byType("guardrail").length).toBeGreaterThanOrEqual(6);
  });

  it("is deterministic for the same provider seed", async () => {
    const a = await runCampaignPipeline({ brief, provider: provider("x"), reviewer: new PolicyReviewer() });
    const b = await runCampaignPipeline({ brief, provider: provider("x"), reviewer: new PolicyReviewer() });
    expect(JSON.stringify(a.ideas.ranked)).toBe(JSON.stringify(b.ideas.ranked));
    expect(JSON.stringify(a.copy?.pack)).toBe(JSON.stringify(b.copy?.pack));
    expect(a.landing[0]!.html).toBe(b.landing[0]!.html);
  });

  it("honours options: idea count, formats, script requests and synthetic presenters", async () => {
    const pkg = await runCampaignPipeline({
      brief,
      provider: provider(),
      ideaCount: 5,
      selectCount: 2,
      formats: ["square"],
      scriptRequests: [{ style: "explainer", targetSeconds: 15 }],
      allowSyntheticPresenter: true,
    });
    expect(pkg.ideas.ranked).toHaveLength(5);
    expect(pkg.creatives).toHaveLength(1);
    expect(pkg.scripts).toHaveLength(1);
    expect(pkg.scripts[0]!.script.style).toBe("explainer");
    expect(pkg.ugc?.persona.synthetic).toBe(true);
    expect(pkg.ugc?.disclosure.aiGenerated).toBe(true);
  });
});

describe("launch plan", () => {
  it("splits budget across audiences and placements and maps creatives by placement", () => {
    const copy = sampleCopy(brief, sampleIdea(brief));
    const plan = buildLaunchPlan(brief, "idea-1", copy, ["creative-idea-1-square", "creative-idea-1-story", "creative-idea-1-landscape"]);
    expect(plan.campaign.dailyBudgetGbp).toBe(250);
    expect(plan.adsets).toHaveLength(6);
    const total = plan.adsets.reduce((s, a) => s + a.dailyBudgetGbp, 0);
    expect(total).toBeCloseTo(250, 0);
    expect(plan.adsets.find((a) => a.placement === "Stories")!.ads[0]!.creativeId).toBe("creative-idea-1-story");
    expect(plan.adsets.find((a) => a.placement === "Feed")!.ads[0]!.creativeId).toBe("creative-idea-1-square");
    expect(plan.adsets[0]!.ads.map((a) => a.landingVariant)).toEqual(["A", "B"]);
    expect(plan.tracking.utmTemplate).toContain("utm_source=meta");
    expect(plan.guardrailsForAgent).toEqual({ targetRoas: 3, targetCpaGbp: 25, autonomy: "assist" });
    expect(plan.campaign.startDate).toBe("2026-12-01");
  });

  it("falls back sensibly without budget or creatives", () => {
    const copy = sampleCopy(brief, sampleIdea(brief));
    const plan = buildLaunchPlan({ ...brief, constraints: {}, objective: "awareness", channels: ["meta_feed"] }, "i", copy, []);
    expect(plan.campaign.dailyBudgetGbp).toBe(100);
    expect(plan.adsets).toHaveLength(2);
    expect(plan.adsets[0]!.optimisation).toBe("REACH");
    expect(plan.adsets[0]!.ads[0]!.creativeId).toBe("pending");
    expect(plan.guardrailsForAgent).toEqual({ autonomy: "assist" });
  });
});

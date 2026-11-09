import { describe, expect, it } from "vitest";
import { MockUgcRenderer, UGC_COST_TABLE, UgcManifestSchema, approveGate, buildUgcManifest, canSubmitForRender, personaTask } from "../../src/areas/ugc";
import { buildMockScript } from "../../src/areas/scripts";
import { provider, sampleBrief, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);
const testimonial = buildMockScript(brief, idea, "ugc-testimonial", 30, 0);
const explainer = buildMockScript(brief, idea, "explainer", 30, 0);

describe("persona casting", () => {
  it("never casts a synthetic presenter for a testimonial, even when allowed", async () => {
    const r = await provider().run(personaTask, { brief, script: testimonial, allowSynthetic: true });
    expect(r.output.synthetic).toBe(false);
    expect(r.output.ageRange).toBe(brief.audience.ageRange);
  });

  it("allows a synthetic presenter for informational scripts only when permitted", async () => {
    const allowed = await provider().run(personaTask, { brief, script: explainer, allowSynthetic: true });
    expect(allowed.output.synthetic).toBe(true);
    const notAllowed = await provider().run(personaTask, { brief, script: explainer, allowSynthetic: false });
    expect(notAllowed.output.synthetic).toBe(false);
  });
});

describe("manifest", () => {
  it("builds a schema-valid manifest with one shot per beat and real-creator defaults", async () => {
    const persona = (await provider().run(personaTask, { brief, script: testimonial, allowSynthetic: false })).output;
    const m = buildUgcManifest(testimonial, brief, { persona });
    expect(UgcManifestSchema.safeParse(m).success).toBe(true);
    expect(m.shots).toHaveLength(testimonial.beats.length);
    expect(m.shots.map((s) => s.beatName)).toEqual(testimonial.beats.map((b) => b.name));
    expect(m.avatar.provider).toBe("real-creator");
    expect(m.voice.provider).toBe("real-creator");
    expect(m.disclosure.aiGenerated).toBe(false);
    expect(m.disclosure.metaAiDisclosureFlag).toBe(false);
    expect(m.estimatedCostGbp).toBe(UGC_COST_TABLE["real-creator"].costGbp);
    expect(m.deliverables.some((d) => d.format.startsWith("srt"))).toBe(true);
  });

  it("switches to AI providers, cost and disclosure for a synthetic persona", async () => {
    const persona = (await provider().run(personaTask, { brief, script: explainer, allowSynthetic: true })).output;
    const m = buildUgcManifest(explainer, brief, { persona });
    expect(m.avatar.provider).toBe("heygen");
    expect(m.voice.provider).toBe("elevenlabs");
    expect(m.disclosure.aiGenerated).toBe(true);
    expect(m.disclosure.metaAiDisclosureFlag).toBe(true);
    expect(m.disclosure.label).toMatch(/created with AI/);
    expect(m.estimatedCostGbp).toBe(UGC_COST_TABLE.heygen.costGbp);
    expect(m.estimatedTurnaroundHours).toBeLessThan(UGC_COST_TABLE["real-creator"].hours);
  });

  it("starts with only the script gate approved", async () => {
    const persona = (await provider().run(personaTask, { brief, script: testimonial, allowSynthetic: false })).output;
    const m = buildUgcManifest(testimonial, brief, { persona, reviewerName: "haseeb" });
    expect(m.approvals.find((a) => a.gate === "script")?.status).toBe("approved");
    expect(m.approvals.filter((a) => a.status === "pending").map((a) => a.gate)).toEqual(["persona", "rough-cut", "final"]);
    expect(m.approvals.every((a) => a.owner === "haseeb")).toBe(true);
  });
});

describe("approval gating and rendering", () => {
  it("refuses to render until persona and rough-cut are approved, then completes", async () => {
    const persona = (await provider().run(personaTask, { brief, script: testimonial, allowSynthetic: false })).output;
    let m = buildUgcManifest(testimonial, brief, { persona });
    expect(canSubmitForRender(m)).toEqual({ ok: false, blockedBy: ["persona", "rough-cut"] });

    const renderer = new MockUgcRenderer();
    const blocked = await renderer.submit(m);
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toMatch(/persona, rough-cut/);

    m = approveGate(m, "persona", "client-services", "Looks right for the audience");
    expect(canSubmitForRender(m).blockedBy).toEqual(["rough-cut"]);
    m = approveGate(m, "rough-cut", "creative-lead");
    expect(canSubmitForRender(m).ok).toBe(true);
    expect(m.approvals.find((a) => a.gate === "persona")?.note).toBe("Looks right for the audience");

    const job = await renderer.submit(m);
    expect(job.status).toBe("queued");
    expect((await renderer.poll(job.jobId)).status).toBe("rendering");
    const done = await renderer.poll(job.jobId);
    expect(done.status).toBe("done");
    expect(done.outputUrl).toContain("9x16.mp4");
    expect((await renderer.poll("nope")).status).toBe("failed");
  });

  it("approveGate does not mutate the original manifest", async () => {
    const persona = (await provider().run(personaTask, { brief, script: testimonial, allowSynthetic: false })).output;
    const m = buildUgcManifest(testimonial, brief, { persona });
    const m2 = approveGate(m, "persona", "x");
    expect(m.approvals.find((a) => a.gate === "persona")?.status).toBe("pending");
    expect(m2.approvals.find((a) => a.gate === "persona")?.status).toBe("approved");
  });
});

import { describe, expect, it } from "vitest";
import { CopyPackSchema, META_TEXT_LIMITS, buildMockCopy, copyGenerationTask, hasMinimumViableCopy, validateCopy } from "../../src/areas/copy";
import { provider, sampleBrief, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);

describe("copy generation", () => {
  it("produces a schema-valid pack that passes every guardrail", async () => {
    const r = await provider().run(copyGenerationTask, { brief, idea });
    expect(CopyPackSchema.safeParse(r.output).success).toBe(true);
    const v = validateCopy(r.output, brief);
    expect(v.overall.ok).toBe(true);
    expect(v.removed).toHaveLength(0);
    expect(v.overall.score).toBeGreaterThanOrEqual(95);
  });

  it("keeps headlines and descriptions inside Meta's recommended limits", () => {
    const pack = buildMockCopy(brief, idea);
    for (const h of pack.headlines) expect(h.length).toBeLessThanOrEqual(META_TEXT_LIMITS.headline.recommended);
    for (const d of pack.descriptions) expect(d.length).toBeLessThanOrEqual(META_TEXT_LIMITS.description.recommended);
    for (const s of pack.storyOverlays) expect(s.length).toBeLessThanOrEqual(META_TEXT_LIMITS.storyOverlay.recommended);
    const short = pack.primaryTexts.find((p) => p.variant === "short")!;
    expect(short.text.length).toBeLessThanOrEqual(META_TEXT_LIMITS.primaryText.recommended);
  });

  it("every primary text contains a call to action and an impact statement", () => {
    const pack = buildMockCopy(brief, idea);
    for (const p of pack.primaryTexts) {
      expect(p.text).toMatch(/donate|give|help/i);
      expect(p.text).toContain("£30");
    }
  });

  it("chooses the CTA button from the objective", () => {
    expect(buildMockCopy(brief, idea).ctaButton).toBe("DONATE_NOW");
    expect(buildMockCopy({ ...brief, objective: "leads" }, idea).ctaButton).toBe("SIGN_UP");
    expect(buildMockCopy({ ...brief, objective: "awareness" }, idea).ctaButton).toBe("LEARN_MORE");
    expect(buildMockCopy({ ...brief, objective: "regular_giving" }, idea).ctaButton).toBe("DONATE_NOW");
  });

  it("uses only numbers from the brief", () => {
    const pack = buildMockCopy(brief, idea);
    const v = validateCopy(pack, brief);
    expect(v.fields.flatMap((f) => f.report.issues).filter((i) => i.rule === "facts.unverified")).toHaveLength(0);
  });
});

describe("copy validation", () => {
  it("removes blocked variants and keeps the rest", () => {
    const pack = buildMockCopy(brief, idea);
    pack.headlines = [...pack.headlines, "We guarantee warmth", "Email jane@example.org"];
    pack.primaryTexts = [...pack.primaryTexts, { variant: "long", text: "Help [NAME] today. Donate now to keep someone warm this winter.", angle: "x" }];
    const v = validateCopy(pack, brief);
    expect(v.overall.ok).toBe(false);
    expect(v.removed.map((r) => r.field)).toEqual(expect.arrayContaining(["headline", "headline", "primaryText"]));
    expect(v.cleaned.headlines).not.toContain("We guarantee warmth");
    expect(v.cleaned.headlines).toHaveLength(pack.headlines.length - 2);
    expect(v.cleaned.primaryTexts).toHaveLength(pack.primaryTexts.length - 1);
  });

  it("warns (not blocks) on over-length headlines and missing CTAs", () => {
    const pack = buildMockCopy(brief, idea);
    pack.headlines = ["This headline is deliberately far too long for a mobile feed placement"];
    pack.primaryTexts = [{ variant: "short", text: "Winter is cold and older people struggle in silence every year.", angle: "x" }];
    const v = validateCopy(pack, brief);
    const headline = v.fields.find((f) => f.field === "headline")!;
    expect(headline.report.ok).toBe(true);
    expect(headline.report.issues.map((i) => i.rule)).toContain("length.recommended");
    const primary = v.fields.find((f) => f.field === "primaryText")!;
    expect(primary.report.issues.map((i) => i.rule)).toContain("cta.missing");
  });

  it("blocks text over Meta's hard limits", () => {
    const pack = buildMockCopy(brief, idea);
    pack.headlines = ["x".repeat(META_TEXT_LIMITS.headline.max + 1)];
    const v = validateCopy(pack, brief);
    expect(v.fields.find((f) => f.field === "headline")!.report.ok).toBe(false);
  });

  it("hasMinimumViableCopy requires one of each field", () => {
    const pack = buildMockCopy(brief, idea);
    expect(hasMinimumViableCopy(pack)).toBe(true);
    expect(hasMinimumViableCopy({ ...pack, headlines: [] })).toBe(false);
    expect(hasMinimumViableCopy({ ...pack, storyOverlays: [] })).toBe(false);
  });

  it("limits table is internally consistent", () => {
    for (const limit of Object.values(META_TEXT_LIMITS)) expect(limit.recommended).toBeLessThanOrEqual(limit.max);
  });
});

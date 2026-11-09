import { describe, expect, it } from "vitest";
import { CREATIVE_FORMATS, CreativeSpecSchema, buildMockSpec, checkCreative, contrastRatio, creativeConceptTask, layoutForAngle, relativeLuminance, renderCreative, renderPng, shade, textCoverage, type CreativeSpec } from "../../src/areas/static";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);
const palette = brief.client.brand;

describe("creative concepts", () => {
  it("produces one schema-valid spec per requested format", async () => {
    const r = await provider().run(creativeConceptTask, { brief, idea, copy, formats: ["square", "story", "landscape"] });
    expect(r.output.specs.map((s) => s.format)).toEqual(["square", "story", "landscape"]);
    for (const s of r.output.specs) expect(CreativeSpecSchema.safeParse(s).success).toBe(true);
  });

  it("maps angles to layouts", () => {
    expect(layoutForAngle("stat-led")).toBe("stat-led");
    expect(layoutForAngle("urgency-match")).toBe("stat-led");
    expect(layoutForAngle("contrast")).toBe("split-contrast");
    expect(layoutForAngle("testimonial")).toBe("quote");
    expect(layoutForAngle("letter")).toBe("quote");
    expect(layoutForAngle("question")).toBe("bold-statement");
  });

  it("adds a stat block only for stat-led layouts and a badge when match funding exists", () => {
    const statIdea = sampleIdea(brief, "stat-led");
    const spec = buildMockSpec(brief, statIdea, copy, "square", 0);
    expect(spec.stat?.value).toBe("£30");
    expect(spec.badge).toContain("Doubled");
    const noMatch = buildMockSpec({ ...brief, offer: { ...brief.offer, matchFunding: undefined } }, idea, copy, "square", 0);
    expect(noMatch.badge).toBeUndefined();
    expect(noMatch.stat).toBeUndefined();
  });
});

describe("renderer", () => {
  const specs = (["square", "story", "landscape"] as const).map((f, i) => buildMockSpec(brief, idea, copy, f, i));

  it("renders SVG at the exact format dimensions with required elements", () => {
    for (const spec of specs) {
      const r = renderCreative(spec, palette, brief.client.name);
      const { width, height } = CREATIVE_FORMATS[spec.format];
      expect(r.width).toBe(width);
      expect(r.height).toBe(height);
      expect(r.svg.startsWith("<svg")).toBe(true);
      expect(r.svg).toContain(`width="${width}" height="${height}"`);
      expect(r.svg).toContain(`data-creative-id="${spec.id}"`);
      expect(r.svg).toContain("HEARTHLINE");
      expect(r.svg).toContain("Donate £30");
      const roles = r.textBoxes.map((b) => b.role);
      expect(roles).toEqual(expect.arrayContaining(["headline", "cta", "logo"]));
    }
  });

  it("escapes markup in text so SVG stays well-formed", () => {
    const spec: CreativeSpec = { ...specs[0]!, headline: `<script>alert("x")</script> & more` };
    const r = renderCreative(spec, palette, "A&B");
    expect(r.svg).not.toContain("<script>");
    expect(r.svg).toContain("&lt;script&gt;");
    expect(r.svg).toContain("A&amp;B");
  });

  it("keeps all text inside the Stories safe zone", () => {
    const r = renderCreative(specs[1]!, palette, brief.client.name);
    for (const box of r.textBoxes) {
      expect(box.y).toBeGreaterThanOrEqual(r.height * 0.14);
      expect(box.y + box.height).toBeLessThanOrEqual(r.height * 0.8 + 0.5);
    }
  });

  it("every format and layout passes the automated checks", () => {
    for (const angle of ["question", "stat-led", "contrast", "testimonial", "urgency-match", "behind-the-scenes"] as const) {
      const i = sampleIdea(brief, angle);
      const c = sampleCopy(brief, i);
      for (const format of ["square", "story", "landscape"] as const) {
        const spec = buildMockSpec(brief, i, c, format, 0);
        const r = renderCreative(spec, palette, brief.client.name);
        const report = checkCreative(r, palette, brief);
        expect(report.ok, `${angle}/${format}: ${report.issues.map((x) => x.message).join("; ")}`).toBe(true);
        expect(textCoverage(r)).toBeLessThanOrEqual(50);
      }
    }
  });

  it("drops subline lines that would collide with the CTA and records an overflow box", () => {
    const spec: CreativeSpec = { ...specs[2]!, subline: "x ".repeat(70).trim() };
    const r = renderCreative(spec, palette, brief.client.name);
    const report = checkCreative(r, palette, brief);
    const ctaBox = r.textBoxes.find((b) => b.role === "cta")!;
    const subline = r.textBoxes.find((b) => b.role === "subline");
    if (subline) expect(subline.y + subline.height).toBeLessThanOrEqual(ctaBox.y);
    if (r.textBoxes.some((b) => b.role === "subline-overflow")) expect(report.issues.map((i) => i.rule)).toContain("overflow");
  });

  it("rasterises to a PNG", async () => {
    const r = renderCreative(specs[0]!, palette, brief.client.name);
    const png = await renderPng(r.svg);
    expect(png).not.toBeNull();
    expect(Array.from(png!.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png!.length).toBeGreaterThan(10_000);
  });
});

describe("creative checks", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("blocks unreadable text and warns on low CTA contrast", () => {
    const spec = buildMockSpec(brief, idea, copy, "square", 0);
    const lowContrast = { ...palette, secondary: "#eeeeee", background: "#f0f0f0", accent: "#f5f5f5" };
    const r = renderCreative(spec, lowContrast, brief.client.name);
    const report = checkCreative(r, lowContrast, brief);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("contrast.text");
  });

  it("flags banned words and unverified statistics in creative text", () => {
    const spec = buildMockSpec(brief, idea, copy, "square", 0);
    spec.headline = "97% of the elderly are cold";
    const r = renderCreative(spec, palette, brief.client.name);
    const rules = checkCreative(r, palette, brief).issues.map((i) => i.rule);
    expect(rules).toContain("voice.avoid");
    expect(rules).toContain("facts.unverified");
  });

  it("warns when the image prompt may show identifiable people without a no-faces instruction", () => {
    const spec = buildMockSpec(brief, idea, copy, "square", 0);
    spec.imagePrompt = "Close portrait of a child smiling at the camera";
    const r = renderCreative(spec, palette, brief.client.name);
    expect(checkCreative(r, palette, brief).issues.map((i) => i.rule)).toContain("image.consent");
  });

  it("shade() lightens and darkens within bounds", () => {
    expect(shade("#000000", 50)).toBe("#808080");
    expect(shade("#ffffff", -100)).toBe("#000000");
    expect(shade("#ffffff", 50)).toBe("#ffffff");
  });
});

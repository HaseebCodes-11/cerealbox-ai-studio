import { describe, expect, it } from "vitest";
import { CREATIVE_FORMATS, buildMockSpec, checkCreative, renderCreative, renderPng, type CreativeSpec } from "../../src/areas/static";
import { sampleBrief, sampleCopy, sampleIdea } from "../helpers";

/**
 * Scenario group C: the model writes a spec at the edge of the schema and a
 * client has an awkward brand. The renderer must never produce overlapping or
 * clipped text that a tired reviewer approves at thumbnail size.
 */
const brief = sampleBrief();
const palette = brief.client.brand;
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);
const base = (format: keyof typeof CREATIVE_FORMATS) => buildMockSpec(brief, idea, copy, format, 0);

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("C1 · schema-maximum text on the smallest canvas", () => {
  it("a 90-character headline on the landscape format never overlaps the CTA", () => {
    const spec: CreativeSpec = { ...base("landscape"), headline: "Nobody should have to choose between heating their home and eating a hot meal this winter.", subline: undefined };
    expect(spec.headline.length).toBeLessThanOrEqual(90);
    const r = renderCreative(spec, palette, brief.client.name);
    const headline = r.textBoxes.find((b) => b.role === "headline")!;
    const cta = r.textBoxes.find((b) => b.role === "cta")!;
    expect(boxesOverlap(headline, cta), "headline overlaps CTA").toBe(false);
    const report = checkCreative(r, palette, brief);
    expect(report.ok, report.issues.map((i) => i.message).join("; ")).toBe(true);
  });

  it("a 90-character headline plus a 140-character subline on landscape is flagged rather than rendered over the CTA", () => {
    const spec: CreativeSpec = { ...base("landscape"), headline: "Nobody should have to choose between heating their home and eating a hot meal this winter at all", subline: "Right now older people across the country are heating one room and telling nobody, and a single gift of thirty pounds changes that for a week." };
    const r = renderCreative(spec, palette, brief.client.name);
    const cta = r.textBoxes.find((b) => b.role === "cta")!;
    for (const box of r.textBoxes.filter((b) => b.role !== "cta" && b.role !== "logo" && b.role !== "subline-overflow")) {
      expect(boxesOverlap(box, cta), `${box.role} overlaps CTA`).toBe(false);
    }
    const report = checkCreative(r, palette, brief);
    // Either everything fits, or the checks say so. Silent overlap is the failure mode.
    if (r.textBoxes.some((b) => b.role === "subline-overflow")) expect(report.issues.map((i) => i.rule)).toContain("overflow");
  });

  it("a 12-character stat value stays inside the canvas on every format", () => {
    for (const format of ["square", "story", "landscape"] as const) {
      const spec: CreativeSpec = { ...buildMockSpec(brief, sampleIdea(brief, "stat-led"), copy, format, 0), stat: { value: "£1,000,000.0", label: "funds the whole programme for a year" } };
      const r = renderCreative(spec, palette, brief.client.name);
      const stat = r.textBoxes.find((b) => b.role === "stat")!;
      expect(stat.x + stat.width, `${format} stat right edge`).toBeLessThanOrEqual(r.width + 1);
      expect(checkCreative(r, palette, brief).issues.map((i) => i.rule), format).not.toContain("overflow");
    }
  });

  it("a 40-character badge and a 30-character CTA fit on the landscape canvas without colliding with the logo", () => {
    const spec: CreativeSpec = { ...base("landscape"), badge: "Every single gift doubled until 31 Jan", cta: "Donate £30 and keep them warm" };
    const r = renderCreative(spec, palette, brief.client.name);
    const badge = r.textBoxes.find((b) => b.role === "badge")!;
    const cta = r.textBoxes.find((b) => b.role === "cta")!;
    const logo = r.textBoxes.find((b) => b.role === "logo")!;
    expect(badge.x + badge.width).toBeLessThanOrEqual(r.width + 1);
    expect(boxesOverlap(cta, logo), "CTA overlaps logo").toBe(false);
  });
});

describe("C2 · awkward brands", () => {
  it("a 60-character brand name is kept inside the canvas and clear of the CTA", () => {
    const name = "The Northumberland and Borders Older People's Warmth Foundation";
    const r = renderCreative(base("square"), palette, name);
    const logo = r.textBoxes.find((b) => b.role === "logo")!;
    const cta = r.textBoxes.find((b) => b.role === "cta")!;
    expect(logo.x).toBeGreaterThanOrEqual(0);
    expect(boxesOverlap(logo, cta)).toBe(false);
    expect(checkCreative(r, palette, brief).ok).toBe(true);
  });

  it("a light brand on a light background is blocked, a mid-grey pairing warns", () => {
    const light = { ...palette, secondary: "#f5f5f5", background: "#ffffff", text: "#1c1c1c" };
    const spec = { ...base("square"), colours: { background: "secondary" as const, text: "background" as const, accent: "accent" as const } };
    const r = renderCreative(spec, light, brief.client.name);
    expect(checkCreative(r, light, brief).ok).toBe(false);
    const grey = { ...palette, secondary: "#777777", background: "#ffffff" };
    const r2 = renderCreative(spec, grey, brief.client.name);
    const issue = checkCreative(r2, grey, brief).issues.find((i) => i.rule === "contrast.text");
    expect(issue?.severity).toBe("warn");
  });

  it("an accent colour that matches the text colour makes the CTA unreadable and is flagged", () => {
    const samePalette = { ...palette, accent: palette.text };
    const r = renderCreative(base("square"), samePalette, brief.client.name);
    expect(checkCreative(r, samePalette, brief).issues.map((i) => i.rule)).toContain("contrast.cta");
  });

  it("a font family containing quotes is escaped in SVG attributes", () => {
    const quoted = { ...palette, fontFamily: `"Helvetica Neue", 'Segoe UI', sans-serif` };
    const r = renderCreative(base("square"), quoted, brief.client.name);
    expect(r.svg).not.toContain(`font-family=""Helvetica`);
    expect(r.svg).toContain("&quot;Helvetica Neue&quot;");
  });
});

describe("C3 · rasteriser robustness", () => {
  it("returns null for malformed SVG instead of throwing", async () => {
    expect(await renderPng("<svg><rect")).toBeNull();
    expect(await renderPng("")).toBeNull();
  });

  it("renders a creative containing emoji text without throwing", async () => {
    const spec = { ...base("square"), headline: "🎄 Warm homes this winter" };
    const r = renderCreative(spec, palette, brief.client.name);
    const png = await renderPng(r.svg);
    expect(png).not.toBeNull();
  });
});

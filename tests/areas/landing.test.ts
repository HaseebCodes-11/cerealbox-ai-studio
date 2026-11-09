import { describe, expect, it } from "vitest";
import { LandingPageSpecSchema, buildMockLandingSpec, checkLandingPage, landingSpecTask, renderLandingPage, variantDiff } from "../../src/areas/landing";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);

describe("landing page spec", () => {
  it("generates schema-valid A and B specs that differ in the headline", async () => {
    const a = (await provider().run(landingSpecTask, { brief, idea, copy, variant: "A" })).output;
    const b = (await provider().run(landingSpecTask, { brief, idea, copy, variant: "B" })).output;
    expect(LandingPageSpecSchema.safeParse(a).success).toBe(true);
    expect(LandingPageSpecSchema.safeParse(b).success).toBe(true);
    expect(a.hero.headline).not.toBe(b.hero.headline);
    expect(a.form).toEqual(b.form);
    const diff = variantDiff(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(/^hero\.headline/);
    expect(b.variantHypothesis).toMatch(/Test/);
  });

  it("mirrors the offer tiers in the form and impact blocks and answers the objections", () => {
    const spec = buildMockLandingSpec(brief, idea, copy, "A");
    expect(spec.form.amounts).toEqual([30, 75, 150]);
    expect(spec.form.defaultAmount).toBe(75);
    expect(spec.impact.map((i) => i.amount)).toEqual([30, 75, 150]);
    expect(spec.faq.length).toBeGreaterThanOrEqual(brief.audience.objections.length);
    expect(spec.faq.map((f) => f.question)).toContain("How much of my donation goes on admin?");
    expect(spec.faq.map((f) => f.question)).toContain("Doesn't the government cover heating costs?");
    expect(spec.form.giftAid).toBe(true);
    expect(spec.trust.some((t) => t.includes(brief.client.charityNumber!))).toBe(true);
    expect(spec.title.length).toBeLessThanOrEqual(60);
    expect(spec.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("puts monthly first for regular giving campaigns", () => {
    const spec = buildMockLandingSpec({ ...brief, objective: "regular_giving" }, idea, copy, "A");
    expect(spec.form.frequencies[0]).toBe("monthly");
  });
});

describe("landing page render + checks", () => {
  const spec = buildMockLandingSpec(brief, idea, copy, "A");
  const html = renderLandingPage(spec, brief.client);

  it("renders a valid structure that passes every check", () => {
    const report = checkLandingPage(spec, html, brief);
    expect(report.ok, report.issues.map((i) => i.message).join("; ")).toBe(true);
    expect(report.issues.filter((i) => i.severity !== "info")).toHaveLength(0);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('data-cta="hero"');
    expect(html).toContain("Gift Aid");
    expect(html).toContain("UK taxpayer");
    expect(html).toContain(brief.client.charityNumber!);
    expect(html).toContain('name="utm_source"');
    expect(html).toContain('<meta name="x-variant" content="A">');
    for (const amt of [30, 75, 150]) expect(html).toContain(`value="${amt}"`);
    expect(html).toContain('value="75" checked');
    expect(html).toContain(brief.client.brand.primary);
  });

  it("escapes user-controlled text", () => {
    const evil = { ...spec, hero: { ...spec.hero, headline: `<img src=x onerror=alert(1)> & co` } };
    const out = renderLandingPage(evil, brief.client);
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; co");
  });

  it("blocks pages with two H1s, no Gift Aid, missing charity number or mismatched amounts", () => {
    const twoH1 = html.replace("<h2>The problem, plainly</h2>", "<h1>The problem, plainly</h1>");
    expect(checkLandingPage(spec, twoH1, brief).issues.map((i) => i.rule)).toContain("seo.h1");

    const noGiftAid = { ...spec, form: { ...spec.form, giftAid: false } };
    const r1 = checkLandingPage(noGiftAid, renderLandingPage(noGiftAid, brief.client), brief);
    expect(r1.ok).toBe(false);
    expect(r1.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["giftaid.offered", "giftaid.declaration"]));

    const specNoNumber = { ...spec, trust: spec.trust.filter((t) => !t.includes(brief.client.charityNumber!)) };
    const noNumber = renderLandingPage(specNoNumber, { ...brief.client, charityNumber: undefined });
    expect(checkLandingPage(specNoNumber, noNumber, brief).issues.map((i) => i.rule)).toContain("compliance.charity-number");

    const wrongAmounts = { ...spec, form: { ...spec.form, amounts: [10, 20, 30], defaultAmount: 20 } };
    const r2 = checkLandingPage(wrongAmounts, renderLandingPage(wrongAmounts, brief.client), brief);
    expect(r2.issues.map((i) => i.rule)).toContain("form.amounts-match-offer");

    const badDefault = { ...spec, form: { ...spec.form, defaultAmount: 999 } };
    expect(checkLandingPage(badDefault, renderLandingPage(badDefault, brief.client), brief).issues.map((i) => i.rule)).toContain("form.default");
  });

  it("flags missing hero CTA, images without alt and placeholder copy", () => {
    const noCta = html.replace('data-cta="hero"', 'data-cta="nope"');
    expect(checkLandingPage(spec, noCta, brief).issues.map((i) => i.rule)).toContain("cta.above-fold");
    const badImg = html.replace("</main>", '<img src="x.png"></main>');
    expect(checkLandingPage(spec, badImg, brief).issues.map((i) => i.rule)).toContain("a11y.alt");
    const placeholder = { ...spec, story: { ...spec.story, body: `${spec.story.body} [INSERT QUOTE]` } };
    const r = checkLandingPage(placeholder, renderLandingPage(placeholder, brief.client), brief);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain("placeholder");
  });

  it("warns on long titles and missing UTM fields", () => {
    const longTitle = { ...spec, title: "x".repeat(61) };
    expect(checkLandingPage(longTitle, html, brief).issues.map((i) => i.rule)).toContain("seo.title");
    const noUtm = html.replace(/name="utm_source"/g, 'name="src"');
    expect(checkLandingPage(spec, noUtm, brief).issues.find((i) => i.rule === "tracking.utm")?.severity).toBe("warn");
  });
});

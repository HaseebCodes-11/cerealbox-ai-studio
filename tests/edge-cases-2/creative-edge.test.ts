/**
 * Second production-breakage pass · ideas, copy, statics, scripts, UGC, landing.
 */
import { describe, expect, it } from "vitest";
import { rankIdeas, selectIdeas } from "../../src/areas/ideas/scoring";
import { buildMockIdea, ideaGenerationTask } from "../../src/areas/ideas/generate";
import { buildMockCopy } from "../../src/areas/copy/generate";
import { validateCopy } from "../../src/areas/copy/validate";
import { buildMockSpec, creativeConceptTask } from "../../src/areas/static/concept";
import { CreativeSpecSchema } from "../../src/areas/static/types";
import { renderCreative } from "../../src/areas/static/render";
import { checkCreative } from "../../src/areas/static/checks";
import { buildMockScript } from "../../src/areas/scripts/generate";
import { validateScript } from "../../src/areas/scripts/validate";
import { buildUgcManifest, canSubmitForRender, personaTask } from "../../src/areas/ugc/pipeline";
import { buildMockLandingSpec, landingSpecTask } from "../../src/areas/landing/generate";
import { LandingPageSpecSchema } from "../../src/areas/landing/types";
import { renderLandingPage } from "../../src/areas/landing/render";
import { checkLandingPage } from "../../src/areas/landing/checks";
import { MockProvider } from "../../src/core/llm";
import type { RankedIdea } from "../../src/areas/ideas/types";
import { sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const provider = new MockProvider();

describe("K1 · idea ranking and selection", () => {
  const brief = sampleBrief();
  const ideas = ["question", "contrast", "letter", "stat-led"].map((a, i) => buildMockIdea(brief, a as never, i));
  const ranked = rankIdeas(ideas, brief);

  it.fails("[BUG2-16] selectIdeas with count 0 returns nothing even when formats are required", () => {
    expect(selectIdeas(ranked, 0, ["static", "video"])).toEqual([]);
  });

  it("selectIdeas never returns more than count", () => {
    for (const n of [1, 2, 3, 4, 9]) expect(selectIdeas(ranked, n, ["static", "video", "ugc", "landing"]).length).toBeLessThanOrEqual(Math.min(n, ranked.length));
  });

  it("a duplicate threshold of 0 marks every idea after the first as a duplicate, 1 marks none", () => {
    expect(rankIdeas(ideas, brief, { duplicateThreshold: 0 }).filter((r) => r.duplicateOf).length).toBe(ideas.length - 1);
    expect(rankIdeas(ideas, brief, { duplicateThreshold: 1 }).filter((r) => r.duplicateOf).length).toBe(0);
  });

  it("ideas identical to the bank score zero novelty but are still ranked and never NaN", () => {
    const r = rankIdeas(ideas, brief, { previousIdeas: ideas.map((i) => `${i.title} ${i.hook} ${i.concept}`) });
    for (const x of r) {
      expect(x.scores.novelty).toBe(0);
      expect(Number.isFinite(x.total)).toBe(true);
    }
  });

  it.fails("[BUG2-17] excluding every angle still yields ideas (rotation resets instead of crashing)", async () => {
    const result = await provider.run(ideaGenerationTask, { brief, count: 3, previousIdeas: [], excludeAngles: [...new Set(ideas.map((i) => i.angle)), "testimonial", "myth-bust", "behind-the-scenes", "urgency-match", "founder-direct", "how-it-works", "local-pride", "unexpected-comparison"] as never });
    expect(result.output.ideas.length).toBe(3);
  });

  it.fails("[BUG2-18] a count of 0 is rejected clearly rather than failing schema validation deep in the provider", async () => {
    await expect(provider.run(ideaGenerationTask, { brief, count: 0, previousIdeas: [], excludeAngles: [] })).rejects.toThrow(/count/i);
  });
});

describe("K2 · copy for objectives and eligibility other than the happy path", () => {
  it.fails("[BUG2-19] a charity that is not Gift Aid eligible gets no Gift Aid line anywhere in the copy pack", () => {
    const brief = sampleBrief();
    brief.offer.giftAidEligible = false;
    const pack = buildMockCopy(brief, sampleIdea(brief));
    const all = [...pack.hooks, ...pack.headlines, ...pack.descriptions, ...pack.storyOverlays, ...pack.messagingPillars, ...pack.primaryTexts.map((p) => p.text)].join("\n");
    expect(all).not.toMatch(/gift aid/i);
  });

  it.fails("[BUG2-20] a leads campaign does not ask people to donate", () => {
    const brief = sampleBrief();
    brief.objective = "leads";
    brief.offer.ask = "Sign the pledge to keep a neighbour warm";
    const pack = buildMockCopy(brief, sampleIdea(brief));
    expect(pack.ctaButton).toBe("SIGN_UP");
    expect(pack.primaryTexts.map((p) => p.text).join("\n")).not.toMatch(/\bdonate\b/i);
  });

  it("validateCopy keeps a pack whose only problem is a recommended-length warning", () => {
    const brief = sampleBrief();
    const pack = buildMockCopy(brief, sampleIdea(brief));
    pack.headlines[0] = "A headline that is a little longer than forty characters";
    const v = validateCopy(pack, brief);
    expect(v.cleaned.headlines).toContain(pack.headlines[0]);
    expect(v.fields.find((f) => f.field === "headline" && f.index === 0)!.report.issues.map((i) => i.rule)).toContain("length.recommended");
  });

  it.fails("[BUG2-21] duplicate variants in a pack are collapsed so Meta does not see the same ad twice", () => {
    const brief = sampleBrief();
    const pack = buildMockCopy(brief, sampleIdea(brief));
    pack.headlines = [pack.headlines[0]!, pack.headlines[0]!, pack.headlines[1]!];
    const v = validateCopy(pack, brief);
    expect(new Set(v.cleaned.headlines).size).toBe(v.cleaned.headlines.length);
  });
});

describe("K3 · creative specs from unusual briefs", () => {
  it.fails("[BUG2-22] a tier amount with pence and millions still produces a schema-valid stat value", async () => {
    const brief = sampleBrief();
    brief.offer.donationTiers[0]!.amount = 1234567.89;
    const idea = buildMockIdea(brief, "stat-led", 0);
    const result = await provider.run(creativeConceptTask, { brief, idea, copy: sampleCopy(brief, idea), formats: ["square"] });
    expect(CreativeSpecSchema.safeParse(result.output.specs[0]).success).toBe(true);
  });

  it("the creative QA blocks an identical text and background role even when the palette itself is fine", () => {
    const brief = sampleBrief();
    const spec = buildMockSpec(brief, sampleIdea(brief), sampleCopy(brief), "square", 0);
    spec.colours = { background: "background", text: "background", accent: "accent" };
    const rendered = renderCreative(spec, brief.client.brand, brief.client.name);
    expect(checkCreative(rendered, brief.client.brand, brief).ok).toBe(false);
  });

  it("a three-character headline and a three-character CTA render and pass structural checks", () => {
    const brief = sampleBrief();
    const spec = buildMockSpec(brief, sampleIdea(brief), sampleCopy(brief), "landscape", 0);
    spec.headline = "Now";
    spec.cta = "Go!";
    delete spec.subline;
    const rendered = renderCreative(spec, brief.client.brand, brief.client.name);
    const report = checkCreative(rendered, brief.client.brand, brief);
    expect(report.issues.map((i) => i.rule)).not.toContain("overflow");
    expect(report.issues.map((i) => i.rule)).not.toContain("cta.missing");
  });

  it("an image prompt naming children without a no-faces clause warns about consent", () => {
    const brief = sampleBrief();
    const spec = buildMockSpec(brief, sampleIdea(brief), sampleCopy(brief), "square", 0);
    spec.imagePrompt = "Children playing in a school hall, warm light, documentary style.";
    const rendered = renderCreative(spec, brief.client.brand, brief.client.name);
    expect(checkCreative(rendered, brief.client.brand, brief).issues.map((i) => i.rule)).toContain("image.consent");
  });
});

describe("K4 · scripts with awkward inputs", () => {
  it("a 15-second script from a brief with a one-word proof point still validates", () => {
    const brief = sampleBrief();
    brief.client.proofPoints = ["Trusted."];
    const script = buildMockScript(brief, sampleIdea(brief), "problem-solution", 15, 0);
    const report = validateScript(script, brief);
    expect(report.issues.filter((i) => i.severity === "block")).toEqual([]);
  });

  it("an idea hook of 40 words is compacted so the hook beat still lands in 3 seconds", () => {
    const brief = sampleBrief();
    const idea = sampleIdea(brief);
    idea.hook = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const script = buildMockScript(brief, idea, "problem-solution", 30, 0);
    const hook = script.beats.find((b) => b.name === "hook")!;
    expect(hook.voiceover.split(/\s+/).length).toBeLessThanOrEqual(16);
    expect(hook.onScreenText.length).toBeLessThanOrEqual(80);
  });

  it("validateScript blocks a beat with NaN seconds and a beat with no visual", () => {
    const brief = sampleBrief();
    const script = buildMockScript(brief, sampleIdea(brief), "problem-solution", 30, 0);
    script.beats[1]!.seconds = Number.NaN;
    script.beats[2]!.visual = "   ";
    const rules = validateScript(script, brief).issues.map((i) => i.rule);
    expect(rules).toContain("beat.seconds");
    expect(rules).toContain("beat.visual");
  });

  it("a 60-second founder script stays inside the spoken-time budget", () => {
    const brief = sampleBrief();
    const script = buildMockScript(brief, sampleIdea(brief), "founder-direct", 60, 0);
    expect(validateScript(script, brief).issues.map((i) => i.rule)).not.toContain("duration.voiceover");
  });
});

describe("K5 · UGC compliance", () => {
  it.fails("[BUG2-23] a synthetic presenter is refused for a testimonial script even if the model proposes one", async () => {
    const brief = sampleBrief();
    const script = buildMockScript(brief, sampleIdea(brief), "ugc-testimonial", 30, 0);
    const persona = (await provider.run(personaTask, { brief, script, allowSynthetic: true })).output;
    expect(persona.synthetic).toBe(false);
    const forced = { ...persona, synthetic: true };
    expect(() => buildUgcManifest(script, brief, { persona: forced })).toThrow(/testimonial/i);
  });

  it("an age range like '65+' or '35–55' with an en dash still yields a sensible persona age", async () => {
    for (const range of ["65+", "35–55", "25 to 34"]) {
      const brief = sampleBrief();
      brief.audience.ageRange = range;
      const script = buildMockScript(brief, sampleIdea(brief), "ugc-testimonial", 30, 0);
      const persona = (await provider.run(personaTask, { brief, script, allowSynthetic: false })).output;
      const age = Number(persona.name.match(/, (\d+),/)?.[1]);
      expect(Number.isFinite(age), range).toBe(true);
      expect(age, range).toBeGreaterThanOrEqual(18);
      expect(age, range).toBeLessThanOrEqual(90);
    }
  });

  it("a manifest cannot be submitted while the persona gate is pending", async () => {
    const brief = sampleBrief();
    const script = buildMockScript(brief, sampleIdea(brief), "ugc-testimonial", 30, 0);
    const persona = (await provider.run(personaTask, { brief, script, allowSynthetic: false })).output;
    expect(canSubmitForRender(buildUgcManifest(script, brief, { persona })).blockedBy).toContain("persona");
  });
});

describe("K6 · landing pages from thin or unusual briefs", () => {
  it.fails("[BUG2-24] a one-sentence case study still produces a schema-valid landing spec", async () => {
    const brief = sampleBrief();
    brief.creativeContext.caseStudy = "A real case.";
    const idea = sampleIdea(brief);
    const result = await provider.run(landingSpecTask, { brief, idea, copy: sampleCopy(brief, idea), variant: "A" });
    expect(LandingPageSpecSchema.safeParse(result.output).success).toBe(true);
  });

  it.fails("[BUG2-25] a very short ask and client name still produce a title of at least 10 characters", () => {
    const brief = sampleBrief();
    brief.offer.ask = "Give";
    brief.client.name = "Yo";
    const spec = buildMockLandingSpec(brief, sampleIdea(brief), sampleCopy(brief), "A");
    expect(LandingPageSpecSchema.safeParse(spec).success).toBe(true);
  });

  it.fails("[BUG2-26] offering Gift Aid on a page for a charity that is not eligible is blocked", () => {
    const brief = sampleBrief();
    brief.offer.giftAidEligible = false;
    const spec = buildMockLandingSpec(brief, sampleIdea(brief), sampleCopy(brief), "A");
    spec.form.giftAid = true;
    const html = renderLandingPage(spec, brief.client);
    const report = checkLandingPage(spec, html, brief);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("giftaid.ineligible");
  });

  it.fails("[BUG2-27] variant B is not indexable as a duplicate of variant A", () => {
    const brief = sampleBrief();
    const idea = sampleIdea(brief);
    const copy = sampleCopy(brief, idea);
    const a = renderLandingPage(buildMockLandingSpec(brief, idea, copy, "A"), brief.client);
    const b = renderLandingPage(buildMockLandingSpec(brief, idea, copy, "B"), brief.client);
    expect(a).toMatch(/<meta name="robots" content="index,follow">/);
    expect(b).toMatch(/noindex|<link rel="canonical"/);
  });

  it("a USD campaign renders dollar amounts and does not describe donors as UK taxpayers", () => {
    const brief = sampleBrief();
    brief.offer.donationTiers = brief.offer.donationTiers.map((t) => ({ ...t, currency: "USD" }));
    brief.offer.giftAidEligible = false;
    const spec = buildMockLandingSpec(brief, sampleIdea(brief), sampleCopy(brief), "A");
    const html = renderLandingPage(spec, brief.client);
    expect(html).toContain("$30");
    expect(html).not.toContain("UK taxpayer");
  });

  it("a FAQ built from eight objections stays within the schema maximum of six", () => {
    const brief = sampleBrief();
    brief.audience.objections = Array.from({ length: 8 }, (_, i) => `Objection number ${i + 1} about the appeal`);
    const spec = buildMockLandingSpec(brief, sampleIdea(brief), sampleCopy(brief), "A");
    expect(spec.faq.length).toBeLessThanOrEqual(6);
    expect(LandingPageSpecSchema.safeParse(spec).success).toBe(true);
  });
});

/** Shared helper so a ranked list can be hand-built in tests without the provider. */
export function asRanked(ideas: RankedIdea[]): RankedIdea[] {
  return ideas;
}

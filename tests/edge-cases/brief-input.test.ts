import { describe, expect, it } from "vitest";
import { parseBrief, type CampaignBrief } from "../../src/core/brief";
import { runCampaignPipeline } from "../../src/orchestrator";
import { buildMockIdea, ideaGenerationTask } from "../../src/areas/ideas";
import { buildMockCopy, validateCopy } from "../../src/areas/copy";
import { buildMockScript, validateScript } from "../../src/areas/scripts";
import { provider, sampleBrief } from "../helpers";

/**
 * Scenario group A: what a real strategist types into a brief.
 * Briefs are the one input humans write by hand, so they will contain typos,
 * emoji, quotes, pasted HTML, extreme amounts, and missing optional parts.
 */
const raw = () => JSON.parse(JSON.stringify(sampleBrief())) as Record<string, any>;

describe("A1 · malformed and hostile brief input", () => {
  it("rejects a brief missing required fields with a readable error, not a crash", () => {
    const r = raw();
    delete r.client.proofPoints;
    expect(() => parseBrief(r)).toThrow(/proofPoints/);
    const r2 = raw();
    r2.offer.donationTiers[0].amount = "thirty";
    expect(() => parseBrief(r2)).toThrow(/amount/);
  });

  it("rejects negative, zero and non-numeric amounts and budgets", () => {
    for (const bad of [0, -5, "20", null]) {
      const r = raw();
      r.offer.donationTiers[0].amount = bad;
      expect(() => parseBrief(r), String(bad)).toThrow();
    }
    const r = raw();
    r.constraints.dailyBudgetGbp = -1;
    expect(() => parseBrief(r)).toThrow();
  });

  it("rejects an invalid website URL and a non-hex brand colour", () => {
    const r = raw();
    r.client.website = "hearthline.example.org";
    expect(() => parseBrief(r)).toThrow();
    const r2 = raw();
    r2.client.brand.accent = "#FFF";
    expect(() => parseBrief(r2)).toThrow(/hex/);
  });

  it("accepts a minimal brief: one tier, no objections, no match, no deadline, no charity number", () => {
    const r = raw();
    r.offer.donationTiers = [{ amount: 10, impact: "feeds one child for a day" }];
    r.audience.objections = [];
    delete r.offer.matchFunding;
    delete r.offer.deadline;
    delete r.client.charityNumber;
    delete r.creativeContext;
    const brief = parseBrief(r);
    expect(brief.creativeContext.beneficiarySingular).toBe("someone");
    expect(brief.offer.donationTiers).toHaveLength(1);
  });

  it.fails("[BUG-01] the whole pipeline completes on the minimal brief", async () => {
    const r = raw();
    r.offer.donationTiers = [{ amount: 10, impact: "feeds one child for a day" }];
    r.audience.objections = [];
    delete r.offer.matchFunding;
    delete r.offer.deadline;
    delete r.client.charityNumber;
    delete r.creativeContext;
    const pkg = await runCampaignPipeline({ brief: parseBrief(r), provider: provider() });
    expect(pkg.status, pkg.stoppedAt).toBe("complete");
    expect(pkg.landing.every((l) => l.report.ok)).toBe(true);
    expect(pkg.creatives.every((c) => c.report.ok)).toBe(true);
  });
});

describe("A2 · text that breaks markup: quotes, HTML, emoji, unicode", () => {
  const hostile = (): CampaignBrief => {
    const r = raw();
    r.client.name = `O'Hara & Sons <script>alert("x")</script> 🎄`;
    r.campaignName = `Winter "Warmth" <b>Appeal</b> — 2026`;
    r.offer.ask = `Help "them" & <us> stay warm`;
    r.client.voice.exampleLines = [`"Quoted" line & <tag>`];
    r.creativeContext.openingQuestion = `Isn't it "cold" & <dark>?`;
    r.creativeContext.storySeed = `My nan said "I'm fine" & wasn't.`;
    return parseBrief(r);
  };

  it("never emits raw <script> or unescaped quotes into SVG, landing HTML or dashboards", async () => {
    const pkg = await runCampaignPipeline({ brief: hostile(), provider: provider() });
    expect(pkg.status).toBe("complete");
    for (const c of pkg.creatives) {
      // The wordmark is upper-cased, so match case-insensitively.
      expect(c.rendered.svg).not.toMatch(/<script>/i);
      expect(c.rendered.svg).toMatch(/&lt;script&gt;/i);
    }
    for (const l of pkg.landing) {
      expect(l.html).not.toMatch(/<script>alert/);
      expect(l.html).toContain("&lt;script&gt;");
      expect(l.html).toContain("O&#39;Hara &amp; Sons");
    }
  });

  it("emoji and multi-byte characters do not break length limits silently", () => {
    const brief = hostile();
    const idea = buildMockIdea(brief, "question", 0);
    const pack = buildMockCopy(brief, idea);
    const v = validateCopy(pack, brief);
    // Length checks count UTF-16 units; a 🎄 is 2. We only require no crash and limits still enforced.
    expect(v.fields.length).toBeGreaterThan(0);
    for (const h of pack.headlines) expect([...h].length).toBeLessThanOrEqual(40);
  });

  it("slugs and file names from hostile campaign names are filesystem-safe", () => {
    const brief = hostile();
    const idea = buildMockIdea(brief, "contrast", 0);
    expect(idea.id).toMatch(/^[a-z0-9-]+$/);
    const script = buildMockScript(brief, idea, "founder-direct", 15, 0);
    expect(script.id).toMatch(/^[a-z0-9-]+$/i);
    expect(script.id).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe("A3 · extreme values", () => {
  it.fails("[BUG-02] very large and decimal donation amounts format and verify", async () => {
    const r = raw();
    r.offer.donationTiers = [
      { amount: 2.5, impact: "buys a hot drink" },
      { amount: 1_000_000, impact: "funds the whole programme for a year" },
    ];
    const brief = parseBrief(r);
    const pkg = await runCampaignPipeline({ brief, provider: provider() });
    expect(pkg.status, pkg.stoppedAt).toBe("complete");
    expect(pkg.landing[0]!.html).toContain('value="2.5"');
    expect(pkg.landing[0]!.html).toContain("£1,000,000");
    expect(pkg.copy!.validation.fields.flatMap((f) => f.report.issues).filter((i) => i.rule === "facts.unverified")).toHaveLength(0);
  });

  it("a brief with the schema maximum of six tiers still renders a valid form", async () => {
    const r = raw();
    r.offer.donationTiers = [5, 10, 20, 50, 100, 250].map((amount) => ({ amount, impact: `does ${amount} units of good` }));
    const pkg = await runCampaignPipeline({ brief: parseBrief(r), provider: provider() });
    expect(pkg.status, pkg.stoppedAt).toBe("complete");
    expect((pkg.landing[0]!.html.match(/<input type="radio" name="amount"/g) ?? []).length).toBe(7); // 6 + Other
  });

  it("a brief with seven tiers fails clearly at the landing page spec, not silently", async () => {
    const r = raw();
    r.offer.donationTiers = [5, 10, 20, 50, 100, 250, 500].map((amount) => ({ amount, impact: `does ${amount} units of good` }));
    const brief = parseBrief(r);
    await expect(runCampaignPipeline({ brief, provider: provider() })).rejects.toThrow(/landing\.spec|amounts/);
  });

  it.fails("[BUG-01] an impact line of one word produces a landing spec that still meets the schema", async () => {
    const r = raw();
    r.offer.donationTiers = [{ amount: 10, impact: "helps" }];
    r.keyMessage = "Help.";
    const brief = parseBrief(r);
    const pkg = await runCampaignPipeline({ brief, provider: provider() });
    expect(pkg.status, pkg.stoppedAt).toBe("complete");
  });

  it.fails("[BUG-03] very long client and campaign names do not overflow creatives or break the wordmark", async () => {
    const r = raw();
    r.client.name = "The Northumberland and Borders Older People's Warmth Foundation";
    r.campaignName = "Extraordinarily Long Winter Warmth And Wellbeing Appeal For Everyone 2026";
    const brief = parseBrief(r);
    const pkg = await runCampaignPipeline({ brief, provider: provider() });
    for (const c of pkg.creatives) {
      for (const box of c.rendered.textBoxes) {
        expect(box.x, `${c.rendered.spec.id} ${box.role} x`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${c.rendered.spec.id} ${box.role} right edge`).toBeLessThanOrEqual(c.rendered.width + 1);
      }
      const logo = c.rendered.textBoxes.find((b) => b.role === "logo")!;
      const cta = c.rendered.textBoxes.find((b) => b.role === "cta")!;
      expect(logo.x, `${c.rendered.spec.id} logo overlaps CTA`).toBeGreaterThanOrEqual(cta.x + cta.width);
    }
  });

  it("creative context seeds that are far too long degrade to warnings, never to blocked scripts", () => {
    const r = raw();
    r.creativeContext.openingQuestion = "When did you last check whether the older person next door to you is managing to keep even one room of their house warm this winter?";
    r.creativeContext.problemInDailyLife = "Older people across the whole of the United Kingdom are quietly heating a single room, skipping meals and going to bed at six to stay warm, and almost none of them ever tell their families.";
    const brief = parseBrief(r);
    const idea = buildMockIdea(brief, "question", 0);
    for (const target of [15, 30, 60] as const) {
      const report = validateScript(buildMockScript(brief, idea, "ugc-testimonial", target, 0), brief);
      expect(report.ok, `${target}s: ${report.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
  });

  it("banned words that are regex metacharacters do not throw", () => {
    const r = raw();
    r.client.voice.avoid = ["100% (guaranteed)", "a+b", "[urgent]", "c.o.l.d"];
    const brief = parseBrief(r);
    const idea = buildMockIdea(brief, "question", 0);
    expect(() => validateCopy(buildMockCopy(brief, idea), brief)).not.toThrow();
    expect(() => ideaGenerationTask.prompt({ brief, count: 3, previousIdeas: [], excludeAngles: [] })).not.toThrow();
  });
});

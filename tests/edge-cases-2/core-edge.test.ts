/**
 * Second production-breakage pass · core (brief, guardrails, text, cost, providers, dates).
 * Each test is a way a strategist, reviewer or data feed could break the system in production.
 * Tests marked it.fails("[BUG2-nn] …") document a confirmed defect (see docs/PRODUCTION_RISKS_2.md).
 */
import { describe, expect, it } from "vitest";
import { CampaignBriefSchema, formatCurrency, parseBrief } from "../../src/core/brief";
import { checkText, graphemeLength } from "../../src/core/guardrails";
import { addDays, daysBetween } from "../../src/core/ads";
import { getProvider, MockProvider, resolveModel } from "../../src/core/llm";
import { slugify, truncate, wrapText } from "../../src/core/text";
import { formatUsd } from "../../src/core/cost";
import { renderCreative } from "../../src/areas/static/render";
import { buildMockSpec } from "../../src/areas/static/concept";
import { sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const raw = () => JSON.parse(JSON.stringify(sampleBrief())) as Record<string, any>;
const issues = (text: string, opts?: Parameters<typeof checkText>[1]) => checkText(text, opts).issues;
const rules = (text: string, opts?: Parameters<typeof checkText>[1]) => issues(text, opts).map((i) => i.rule);

describe("J1 · briefs people actually type", () => {
  it("a lowercase currency code is rejected with the field path, not accepted silently", () => {
    const b = raw();
    b.offer.donationTiers[0].currency = "gbp";
    const r = CampaignBriefSchema.safeParse(b);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/donationTiers/);
  });

  it.fails("[BUG2-01] a typo in an optional field name is reported rather than silently dropping the setting", () => {
    const b = raw();
    delete b.offer.matchFunding;
    b.offer.matchfunding = "Every gift doubled by the Big Give until 7 December";
    const r = CampaignBriefSchema.safeParse(b);
    // Zod strips unknown keys: the strategist believes match funding is set and nothing in the output says it is not.
    expect(r.success ? "accepted silently" : "reported").toBe("reported");
  });

  it.fails("[BUG2-02] blank strings inside list fields (proof points, motivations, tone) are rejected", () => {
    for (const path of [["client", "proofPoints"], ["audience", "motivations"], ["client", "voice", "tone"]]) {
      const b = raw();
      let node = b;
      for (const p of path.slice(0, -1)) node = node[p];
      node[path[path.length - 1]!] = ["", "a real entry"];
      expect(CampaignBriefSchema.safeParse(b).success, path.join(".")).toBe(false);
    }
  });

  it.fails("[BUG2-03] an end date before the start date is rejected", () => {
    const b = raw();
    b.constraints.startDate = "2026-12-01";
    b.constraints.endDate = "2026-11-01";
    expect(CampaignBriefSchema.safeParse(b).success).toBe(false);
  });

  it.fails("[BUG2-04] campaign dates must be ISO dates, not prose like 'next Monday'", () => {
    const b = raw();
    b.constraints.startDate = "next Monday";
    expect(CampaignBriefSchema.safeParse(b).success).toBe(false);
  });

  it.fails("[BUG2-05] an empty font family falls back to a usable font in the creative, not font-family=\"\"", () => {
    const brief = sampleBrief();
    brief.client.brand.fontFamily = "";
    const spec = buildMockSpec(brief, sampleIdea(brief), sampleCopy(brief), "square", 0);
    const rendered = renderCreative(spec, brief.client.brand, brief.client.name);
    expect(rendered.svg).not.toContain('font-family=""');
  });

  it("fewer than three b-roll keywords gives an error that names the field and the minimum", () => {
    const b = raw();
    b.creativeContext.brollKeywords = ["kitchen", "hands"];
    const r = CampaignBriefSchema.safeParse(b);
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.error?.issues);
    expect(text).toMatch(/brollKeywords/);
    expect(text).toMatch(/3/);
  });

  it("website URLs: paths and query strings are fine, ftp and bare domains are not", () => {
    const ok = raw();
    ok.client.website = "https://www.hearthline.org.uk/appeals/winter?utm_source=x";
    expect(CampaignBriefSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["ftp://hearthline.org.uk", "hearthline.org.uk", "//hearthline.org.uk"]) {
      const b = raw();
      b.client.website = bad;
      expect(CampaignBriefSchema.safeParse(b).success, bad).toBe(false);
    }
  });

  it("formatCurrency handles pence, millions, foreign symbols and rounding consistently", () => {
    expect(formatCurrency(30)).toBe("£30");
    expect(formatCurrency(2.5)).toBe("£2.50");
    expect(formatCurrency(0.005)).toBe("£0.01");
    expect(formatCurrency(1_000_000)).toBe("£1,000,000");
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50");
    expect(formatCurrency(99.999, "EUR")).toBe("€100.00");
  });
});

describe("J2 · guardrail evasions a real document carries", () => {
  it.fails("[BUG2-06] a soft hyphen or zero-width space inside a blocked word does not hide it", () => {
    expect(rules("We guaran­tee every gift is doubled. Donate now.")).toContain("claims.guarantee");
    expect(rules("We guar​antee every gift is doubled. Donate now.")).toContain("claims.guarantee");
  });

  it("a non-breaking space between words still matches multi-word patterns", () => {
    expect(rules("You must give today.")).toContain("pressure.obligation");
  });

  it.fails("[BUG2-07] international dialling prefix 0044 is caught like +44", () => {
    expect(rules("Call us on 0044 7700 900123 to give.")).toContain("pii.phone");
    expect(rules("Call us on +44 7700 900123 to give.")).toContain("pii.phone");
  });

  it.fails("[BUG2-08] a year or a UK-format date is not reported as an invented statistic", () => {
    expect(rules("Our Winter 2026 appeal closes on 12/11/2026. Donate £30 today.", { allowedFacts: ["£30"] })).not.toContain("facts.unverified");
    expect(rules("Registered charity since 1998. Donate £30 today.", { allowedFacts: ["£30"] })).not.toContain("facts.unverified");
  });

  it.fails("[BUG2-09] '1 in 10' is supported by an allowed fact written as 'one in ten' and vice versa", () => {
    expect(rules("1 in 10 older people cannot heat their home.", { allowedFacts: ["one in ten older people cannot heat their home"] })).not.toContain("facts.unverified");
    expect(rules("One in ten older people cannot heat their home.", { allowedFacts: ["1 in 10 older people cannot heat their home"] })).not.toContain("facts.unverified");
  });

  it("an allowed '£30' does not make '£3' or '£300' acceptable", () => {
    expect(rules("Just £3 keeps someone warm.", { allowedFacts: ["£30 keeps someone warm for a week"] })).toContain("facts.unverified");
    expect(rules("Just £300 keeps someone warm.", { allowedFacts: ["£30 keeps someone warm for a week"] })).toContain("facts.unverified");
    expect(rules("Just £30 keeps someone warm.", { allowedFacts: ["£30 keeps someone warm for a week"] })).not.toContain("facts.unverified");
  });

  it.fails("[BUG2-10] shorthand and long-form amounts verify against each other (£30k ↔ £30,000, 1.2m ↔ 1,200,000)", () => {
    expect(rules("We raised £30k last winter.", { allowedFacts: ["raised £30,000 last winter"] })).not.toContain("facts.unverified");
    expect(rules("1.2m meals served.", { allowedFacts: ["1,200,000 meals served"] })).not.toContain("facts.unverified");
  });

  it.fails("[BUG2-11] an empty or whitespace-padded banned word never flags everything", () => {
    expect(rules("Donate £30 today.", { avoidWords: [""] })).not.toContain("voice.avoid");
    expect(rules("Donate £30 today.", { avoidWords: ["   "] })).not.toContain("voice.avoid");
    expect(rules("Help vulnerable people.", { avoidWords: ["vulnerable "] })).toContain("voice.avoid");
  });

  it("character limits sit exactly on the boundary", () => {
    const text = "a".repeat(40);
    expect(rules(text, { maxChars: 40 })).not.toContain("length.max");
    expect(rules(`${text}b`, { maxChars: 40 })).toContain("length.max");
    expect(graphemeLength("👩‍👩‍👧‍👦 family")).toBe(8);
  });

  it("a comma-grouped number verifies against its ungrouped allowed form and vice versa", () => {
    expect(rules("Over 2,000 visits a year.", { allowedFacts: ["2000 visits a year"] })).not.toContain("facts.unverified");
    expect(rules("Over 2000 visits a year.", { allowedFacts: ["2,000 visits a year"] })).not.toContain("facts.unverified");
  });

  it("the statistic check still flags a number that is genuinely new", () => {
    expect(rules("97% of donors give again. Donate £30 today.", { allowedFacts: ["£30"] })).toContain("facts.unverified");
  });
});

describe("J3 · text helpers at their limits", () => {
  it("truncate never returns more than max and never a lone ellipsis for max ≥ 2", () => {
    for (const max of [2, 5, 10]) {
      const out = truncate("Winter Warmth Appeal", max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.replace("…", "").length).toBeGreaterThan(0);
    }
  });

  it("wrapText with a zero or negative width puts one word per line instead of looping or dropping words", () => {
    expect(wrapText("one two three", 0)).toEqual(["one", "two", "three"]);
    expect(wrapText("one two three", -5)).toEqual(["one", "two", "three"]);
  });

  it("slugify of names with accents, ampersands and apostrophes stays readable and never empty for Latin text", () => {
    expect(slugify("Tŷ Hafan · Children's Hospice")).toBe("t-hafan-children-s-hospice");
    expect(slugify("Paws & Place")).toBe("paws-place");
    expect(slugify("   ")).toBe("");
  });
});

describe("J4 · cost and provider configuration", () => {
  it.fails("[BUG2-12] LLM_PROVIDER with surrounding whitespace (as .env files often have) is accepted", async () => {
    const p = await getProvider({ LLM_PROVIDER: " mock " });
    expect(p.name).toBe("mock");
  });

  it.fails("[BUG2-13] LLM_PROVIDER=anthropic without a key fails with a message naming ANTHROPIC_API_KEY", async () => {
    await expect(getProvider({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: undefined } as NodeJS.ProcessEnv)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("an unknown effort string on a loosely typed task routes like medium", () => {
    expect(resolveModel({ effort: "max" as never }, { ANTHROPIC_MODEL_MEDIUM: "m", ANTHROPIC_MODEL_LOW: "l" }, "fallback")).toBe("m");
  });

  it.fails("[BUG2-14] formatUsd never prints NaN or negative zero", () => {
    expect(formatUsd(0)).toMatch(/^\$0(\.0+)?$/);
    expect(formatUsd(Number.NaN)).not.toContain("NaN");
  });

  it("the mock provider reports a schema failure as an LLMOutputError naming the task", async () => {
    const task = { name: "t.broken", description: "", schema: { safeParse: () => ({ success: false, error: { message: "bad" } }) } as never, system: "", prompt: () => "", mock: () => ({}) };
    await expect(new MockProvider().run(task as never, {})).rejects.toMatchObject({ name: "LLMOutputError", taskName: "t.broken" });
  });
});

describe("J5 · dates from feeds and operators", () => {
  it.fails("[BUG2-15] an impossible calendar date is reported by name instead of a RangeError from toISOString", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(/2026-02-30/);
    expect(() => daysBetween("2026-13-01", "2026-11-08")).toThrow(/2026-13-01/);
  });

  it("date arithmetic across month and year boundaries and leap days is exact", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-25", "2026-11-01")).toBe(7); // BST ends inside this range; UTC maths must not drift
  });

  it("parseBrief accepts a brief exported from JSON with every default omitted", () => {
    const b = raw();
    delete b.creativeContext;
    delete b.references;
    delete b.constraints;
    delete b.client.complianceNotes;
    delete b.client.voice.avoid;
    const brief = parseBrief(b);
    expect(brief.creativeContext.brollKeywords.length).toBeGreaterThanOrEqual(3);
    expect(brief.client.voice.avoid).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { checkText, escapeRegExp, mergeReports, scoreIssues } from "../../src/core/guardrails";

const rules = (text: string, opts?: Parameters<typeof checkText>[1]) => checkText(text, opts).issues.map((i) => i.rule);

describe("guardrails.checkText", () => {
  it("blocks empty text", () => {
    const r = checkText("   ");
    expect(r.ok).toBe(false);
    expect(r.score).toBe(0);
    expect(r.issues[0]?.rule).toBe("empty");
  });

  it("blocks guarantees and cure claims", () => {
    expect(checkText("We guarantee results.").ok).toBe(false);
    expect(rules("We guarantee results.")).toContain("claims.guarantee");
    expect(rules("This cures loneliness.")).toContain("claims.cure");
  });

  it("warns on 100%/every penny, tax deductible, pressure and superlatives", () => {
    const r = checkText("100% of your donation goes to the cause. Every penny counts. It is tax deductible. You must give. We are the biggest charity.");
    expect(r.ok).toBe(true);
    const fired = r.issues.map((i) => i.rule);
    expect(fired).toEqual(expect.arrayContaining(["claims.hundred-percent", "claims.every-penny", "claims.tax-deductible", "pressure.obligation", "claims.superlative"]));
    expect(r.issues.every((i) => i.severity !== "block")).toBe(true);
  });

  it("blocks placeholders of several shapes", () => {
    for (const text of ["Help [CHARITY] today", "Hi {{first_name}}", "lorem ipsum dolor", "Copy TBD here", "INSERT headline", "Call 0800 XXX now"]) {
      expect(rules(text), text).toContain("placeholder");
    }
  });

  it("blocks PII (email, UK mobile)", () => {
    expect(rules("Email me at someone@example.com")).toContain("pii.email");
    expect(rules("Call 07700 900123 now")).toContain("pii.phone");
    expect(rules("Call +44 7700 900123 now")).toContain("pii.phone");
  });

  it("flags statistics not in the allowed facts, and accepts ones that are", () => {
    const allowed = ["£30 covers a week of heating", "Last winter we helped 4,200 older people"];
    expect(rules("£30 covers a week of heating.", { allowedFacts: allowed })).not.toContain("facts.unverified");
    expect(rules("We helped 4,200 people.", { allowedFacts: allowed })).not.toContain("facts.unverified");
    const r = checkText("97% of people agree. £999 buys a boiler.", { allowedFacts: allowed });
    expect(r.issues.filter((i) => i.rule === "facts.unverified")).toHaveLength(2);
    expect(r.ok).toBe(true);
    expect(checkText("97% of people agree.", { allowedFacts: allowed, strictFacts: true }).ok).toBe(false);
  });

  it("applies hard and recommended length limits", () => {
    const text = "a".repeat(50);
    expect(checkText(text, { maxChars: 40 }).ok).toBe(false);
    expect(rules(text, { maxChars: 40 })).toContain("length.max");
    const warn = checkText(text, { maxChars: 100, recommendedChars: 40 });
    expect(warn.ok).toBe(true);
    expect(warn.issues.map((i) => i.rule)).toContain("length.recommended");
    expect(rules(text, { maxChars: 100, recommendedChars: 60 })).not.toContain("length.recommended");
  });

  it("requires a CTA only when asked", () => {
    expect(rules("Winter is cold.", { requireCta: true })).toContain("cta.missing");
    expect(rules("Winter is cold. Donate today.", { requireCta: true })).not.toContain("cta.missing");
    expect(rules("Winter is cold.")).not.toContain("cta.missing");
  });

  it("flags brand-banned words as warnings with the excerpt", () => {
    const r = checkText("Help the elderly stay warm.", { avoidWords: ["the elderly", "victims"] });
    const issue = r.issues.find((i) => i.rule === "voice.avoid");
    expect(issue?.severity).toBe("warn");
    expect(issue?.excerpt?.toLowerCase()).toBe("the elderly");
  });

  it("adds a readability info note for long dense text only", () => {
    const dense = "Notwithstanding multifaceted socioeconomic determinants, organisational interventions demonstrably ameliorate thermal deprivation among geriatric populations nationally.";
    expect(rules(dense)).toContain("readability");
    expect(rules("Short dense sesquipedalian.")).not.toContain("readability");
  });

  it("scores and merges reports", () => {
    expect(scoreIssues([])).toBe(100);
    expect(scoreIssues([{ rule: "x", severity: "block", message: "" }])).toBe(60);
    expect(scoreIssues([{ rule: "x", severity: "warn", message: "" }, { rule: "y", severity: "info", message: "" }])).toBe(85);
    const merged = mergeReports([checkText("Donate today."), checkText("We guarantee it.")]);
    expect(merged.ok).toBe(false);
    expect(merged.issues.length).toBeGreaterThan(0);
    expect(mergeReports([]).score).toBe(100);
  });

  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c?")).toBe("a\\.b\\*c\\?");
  });
});

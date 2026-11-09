import { describe, expect, it } from "vitest";
import { checkText } from "../../src/core/guardrails";

/**
 * Scenario group B: the guardrails are the last line before a human. They
 * must not miss real problems (false negatives) and must not cry wolf so
 * often that reviewers stop reading them (false positives).
 */
const rules = (text: string, opts?: Parameters<typeof checkText>[1]) => checkText(text, opts).issues.map((i) => i.rule);

describe("B1 · false negatives the model could slip through", () => {
  it.fails("[BUG-14] catches claim variants with different casing and spacing", () => {
    expect(rules("We GUARANTEE warmth.")).toContain("claims.guarantee");
    expect(rules("Guaranteed to help.")).toContain("claims.guarantee");
    expect(rules("100%  of your donation reaches them")).toContain("claims.hundred-percent");
    expect(rules("Every  single  penny goes to the cause")).toContain("claims.every-penny");
  });

  it("catches guilt framing in its common phrasings", () => {
    expect(rules("Older people will die unless you help today.")).toContain("pressure.guilt");
    expect(rules("Children are dying without you.")).toContain("pressure.guilt");
  });

  it.fails("[BUG-15] catches UK mobile numbers in several formats and freephone numbers", () => {
    expect(rules("Text 07700900123 to give")).toContain("pii.phone");
    expect(rules("Call +44 7700 900 123")).toContain("pii.phone");
    expect(rules("Call +447700900123")).toContain("pii.phone");
    // Freephone and landline numbers are also PII-ish contact details that should not appear in paid copy without approval.
    expect(rules("Call 0800 123 4567 now")).toContain("pii.phone");
    expect(rules("Call 0113 496 0000")).toContain("pii.phone");
  });

  it.fails("[BUG-16] catches curly-quoted and unicode-punctuated placeholders", () => {
    expect(rules("Help “[CHARITY]” today")).toContain("placeholder");
    expect(rules("Dear {{ first_name }}")).toContain("placeholder");
    expect(rules("Hi {first_name}, give today")).toContain("placeholder");
    expect(rules("Headline goes here. Donate now.")).toContain("placeholder");
  });

  it.fails("[BUG-17] flags invented statistics written as words-and-digits and as 'k'/'m' shorthand", () => {
    expect(rules("Over 4k people helped. Donate.", { allowedFacts: [] })).toContain("facts.unverified");
    expect(rules("We reached 1.2m families. Donate.", { allowedFacts: [] })).toContain("facts.unverified");
    expect(rules("Nine in ten families are in work. Donate.", { allowedFacts: [] })).toContain("facts.unverified");
  });

  it.fails("[BUG-18] flags a statistic that only partially matches an allowed fact", () => {
    // Allowed: 4,200 helped. Model writes 42,000.
    expect(rules("Last winter we helped 42,000 older people.", { allowedFacts: ["Last winter Hearthline helped 4,200 older people stay warm"] })).toContain("facts.unverified");
    expect(rules("£300 covers a week of heating.", { allowedFacts: ["£30 covers a week of heating for one household"] })).toContain("facts.unverified");
  });
});

describe("B2 · false positives that would make reviewers ignore warnings", () => {
  it("does not flag numbers inside URLs, dates or times as invented statistics", () => {
    expect(rules("Give at hearthline.example.org/winter2026 before 31 January.", { allowedFacts: ["31 January"] })).not.toContain("facts.unverified");
    expect(rules("Doors open at 9am on 12 December.", { allowedFacts: ["12 December"] })).not.toContain("facts.unverified");
    expect(rules("Our 24/7 helpline is open.", { allowedFacts: [] })).not.toContain("facts.unverified");
  });

  it("does not flag social handles as email addresses", () => {
    expect(rules("Follow @hearthline for updates.")).not.toContain("pii.email");
  });

  it("does not flag 'the elderly' inside a longer unrelated word, and respects word boundaries for banned words", () => {
    expect(rules("theelderlycare.org", { avoidWords: ["the elderly"] })).not.toContain("voice.avoid");
    expect(rules("Help victims", { avoidWords: ["victim"] })).not.toContain("voice.avoid");
    expect(rules("Help the victim", { avoidWords: ["victim"] })).toContain("voice.avoid");
  });

  it.fails("[BUG-19] does not treat caption labels in square brackets as placeholders when they are legitimate stage directions", () => {
    // Stage directions like [music swells] are common in scripts; the placeholder rule should be scoped to copy, not scripts.
    expect(rules("[music swells] Donate today.")).not.toContain("placeholder");
  });

  it("a standard Gift Aid declaration passes without warnings", () => {
    const declaration = "I am a UK taxpayer and I want Hearthline to claim Gift Aid on this and any donation I make in the future or have made in the past 4 years. Gift Aid adds 25% at no cost to you.";
    const r = checkText(declaration, { allowedFacts: ["Gift Aid adds 25%", "past 4 years"] });
    expect(r.issues.filter((i) => i.severity !== "info")).toHaveLength(0);
  });

  it.fails("[BUG-20] does not misread 'tax' alone or 'guarantee' in a negation as a blocked claim", () => {
    expect(rules("Gift Aid is a UK tax relief.")).not.toContain("claims.tax-deductible");
    // 'We cannot guarantee' is still risky phrasing for a reviewer, but should not hard-block.
    expect(checkText("We cannot guarantee every outcome, but we try.").issues.find((i) => i.rule === "claims.guarantee")?.severity).not.toBe("block");
  });
});

describe("B3 · robustness", () => {
  it("handles very long text quickly", () => {
    const long = "Donate today and help an older person stay warm. ".repeat(2000);
    const started = Date.now();
    const r = checkText(long, { allowedFacts: [], avoidWords: ["vulnerable"] });
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.ok).toBe(true);
  });

  it("handles text that is only punctuation or control characters", () => {
    expect(checkText("...").ok).toBe(true);
    expect(checkText("\u0000\u0001").issues.length).toBeGreaterThanOrEqual(0);
    expect(checkText("\n\t ").ok).toBe(false);
  });

  it.fails("[BUG-21] character limits are measured in user-perceived characters, not UTF-16 code units", () => {
    const emojiHeadline = "🎄".repeat(21) + "x".repeat(19); // 40 characters as a person counts them
    expect(rules(emojiHeadline, { maxChars: 40 })).not.toContain("length.max");
  });

  it.fails("[BUG-22] maxChars of 0 or negative is treated as 'no limit' rather than blocking everything", () => {
    expect(rules("Donate today.", { maxChars: 0 })).not.toContain("length.max");
  });
});

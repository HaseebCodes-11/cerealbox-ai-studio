/**
 * PERF-04 guard: the cached brand-voice patterns must behave exactly like the
 * per-call `new RegExp` they replaced: whole-word, case-insensitive, regex
 * metacharacters in the word treated literally, repeated calls stable.
 */
import { describe, expect, it } from "vitest";
import { checkText } from "../../src/core/guardrails";

const avoid = ["vulnerable", "the elderly", "victims", "C++ (skills)", "a.b"];
const voice = (text: string) => checkText(text, { avoidWords: avoid }).issues.filter((i) => i.rule === "voice.avoid");

describe("voice.avoid characterisation", () => {
  it("flags whole words case-insensitively and reports the matched excerpt", () => {
    const issues = voice("We help Vulnerable neighbours and THE ELDERLY stay warm.");
    expect(issues.map((i) => [i.message, i.excerpt])).toEqual([
      ['Brand voice avoids "vulnerable".', "Vulnerable"],
      ['Brand voice avoids "the elderly".', "THE ELDERLY"],
    ]);
  });

  it("does not match inside other words", () => {
    expect(voice("invulnerable convictims")).toEqual([]);
  });

  it("treats regex metacharacters in the avoided word literally", () => {
    // "a.b" must match only a literal dot: "axb" would match if the dot were a wildcard.
    expect(voice("a.b and axb").map((i) => i.excerpt)).toEqual(["a.b"]);
    expect(voice("axb only")).toEqual([]);
    // A phrase ending in ")" has no word boundary after it, so it never matched; that quirk is preserved, not fixed, here.
    expect(voice("She has C++ (skills) today")).toEqual([]);
    expect(voice("C++ (skills)x").map((i) => i.excerpt)).toEqual(["C++ (skills)"]);
  });

  it("is stable across repeated calls with the same and different word lists", () => {
    const first = voice("victims of the cold");
    for (let i = 0; i < 50; i++) expect(voice("victims of the cold")).toEqual(first);
    expect(checkText("victims of the cold", { avoidWords: ["cold"] }).issues.filter((i) => i.rule === "voice.avoid").map((i) => i.excerpt)).toEqual(["cold"]);
    expect(voice("victims of the cold")).toEqual(first);
  });
});

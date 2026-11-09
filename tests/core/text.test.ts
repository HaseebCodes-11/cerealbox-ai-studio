import { describe, expect, it } from "vitest";
import { countSentences, countSyllables, countWords, escapeHtml, readingGrade, slugify, spokenSeconds, titleCase, truncate, wrapText } from "../../src/core/text";

describe("text helpers", () => {
  it("counts words and sentences", () => {
    expect(countWords("  one two   three ")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countSentences("Hello. How are you? Fine!")).toBe(3);
    expect(countSentences("no punctuation")).toBe(1);
  });

  it("estimates syllables sensibly", () => {
    expect(countSyllables("cat")).toBe(1);
    expect(countSyllables("warm")).toBe(1);
    expect(countSyllables("heating")).toBe(2);
    expect(countSyllables("donation")).toBe(3);
    expect(countSyllables("")).toBe(0);
  });

  it("gives plain English a lower reading grade than dense prose", () => {
    const plain = "A warm home is not a luxury. Your gift keeps someone warm this week. Give today.";
    const dense = "Notwithstanding multifaceted socioeconomic determinants, the organisation's interventions demonstrably ameliorate thermal deprivation among geriatric populations.";
    expect(readingGrade(plain)).toBeLessThan(readingGrade(dense));
    expect(readingGrade("")).toBe(0);
  });

  it("estimates spoken seconds at 150 wpm by default", () => {
    const thirtyWords = Array(30).fill("word").join(" ");
    expect(spokenSeconds(thirtyWords)).toBe(12);
    expect(spokenSeconds(thirtyWords, 300)).toBe(6);
  });

  it("wraps text greedily without exceeding the limit except for single long words", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
    expect(wrapText("supercalifragilistic", 5)).toEqual(["supercalifragilistic"]);
    expect(wrapText("", 10)).toEqual([]);
  });

  it("slugifies, escapes, truncates and title-cases", () => {
    expect(slugify("Winter Warmth Appeal 2026!")).toBe("winter-warmth-appeal-2026");
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
    expect(truncate("hello world", 20)).toBe("hello world");
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello world", 8).length).toBeLessThanOrEqual(8);
    expect(titleCase("warm homes now")).toBe("Warm Homes Now");
  });
});

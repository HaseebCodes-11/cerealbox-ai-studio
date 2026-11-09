import { describe, expect, it } from "vitest";
import { pad2, round, round2 } from "../../src/core/num";
import { round2 as adsRound2 } from "../../src/core/ads";
import { capitalise, lowerFirst, slugify } from "../../src/core/text";

describe("shared numeric helpers (DEBT-01)", () => {
  it("round defaults to 3 decimals and matches the Math.round(n*1000)/1000 the areas used", () => {
    for (const n of [0, 1.23456, -1.23456, 2.0005, 1e-7, 12345.6789, 0.1 + 0.2]) {
      expect(round(n)).toBe(Math.round(n * 1000) / 1000);
      expect(round(n, 2)).toBe(Math.round(n * 100) / 100);
      expect(round2(n)).toBe(Math.round(n * 100) / 100);
    }
    expect(round(1.005, 0)).toBe(1);
    expect(adsRound2).toBe(round2);
  });
  it("pad2 zero-pads timecode fields", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(7)).toBe("07");
    expect(pad2(59)).toBe("59");
    expect(pad2(123)).toBe("123");
  });
});

describe("shared text helpers", () => {
  it("capitalise and lowerFirst touch only the first character", () => {
    expect(capitalise("older neighbour")).toBe("Older neighbour");
    expect(capitalise("")).toBe("");
    expect(capitalise("£30")).toBe("£30");
    expect(lowerFirst("Hearthline helps")).toBe("hearthline helps");
    expect(lowerFirst("")).toBe("");
    expect(lowerFirst("NHS")).toBe("nHS");
  });
  it("slugify keeps its 60-character default and accepts other caps", () => {
    expect(slugify("Winter Warmth 2026 · Hearthline")).toBe("winter-warmth-2026-hearthline");
    expect(slugify("--Hello, World!--")).toBe("hello-world");
    const long = "a ".repeat(100);
    expect(slugify(long)).toHaveLength(60);
    expect(slugify(long, 80)).toHaveLength(80);
    expect(slugify(long, Infinity)).toHaveLength(199);
    expect(slugify("warm hopeful", Infinity)).toBe("warm-hopeful");
  });
});

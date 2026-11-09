import { describe, expect, it } from "vitest";
import { Rng, hashString } from "../../src/core/rng";

describe("Rng", () => {
  it("is deterministic for the same seed", () => {
    const a = new Rng("seed-1");
    const b = new Rng("seed-1");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new Rng("seed-1").next();
    const b = new Rng("seed-2").next();
    expect(a).not.toBe(b);
  });

  it("next() stays within [0, 1)", () => {
    const rng = new Rng(42);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int() is inclusive of both bounds and covers the range", () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it("pick() returns elements from the list and throws on empty", () => {
    const rng = new Rng(1);
    const items = ["a", "b", "c"];
    for (let i = 0; i < 100; i++) expect(items).toContain(rng.pick(items));
    expect(() => rng.pick([])).toThrow();
  });

  it("shuffle() is a permutation and does not mutate the input", () => {
    const rng = new Rng(3);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = rng.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it("normal() has roughly the requested mean and spread", () => {
    const rng = new Rng(99);
    const samples = Array.from({ length: 20_000 }, () => rng.normal(10, 2));
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const sd = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length);
    expect(mean).toBeCloseTo(10, 0);
    expect(sd).toBeCloseTo(2, 0);
  });

  it("hashString is stable and differs between inputs", () => {
    expect(hashString("cerealbox")).toBe(hashString("cerealbox"));
    expect(hashString("cerealbox")).not.toBe(hashString("cerealbo"));
    expect(hashString("")).toBe(2166136261);
  });
});

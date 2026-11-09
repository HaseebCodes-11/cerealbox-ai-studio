import { describe, expect, it } from "vitest";
import { IDEA_ANGLES, IdeaSchema, buildMockIdea, ideaGenerationTask, jaccard, rankIdeas, selectIdeas, tokenSet, allowedFacts } from "../../src/areas/ideas";
import { provider, sampleBrief } from "../helpers";

const brief = sampleBrief();

describe("idea generation (mock task)", () => {
  it("returns the requested count with unique angles and schema-valid ideas", async () => {
    const r = await provider().run(ideaGenerationTask, { brief, count: 10, previousIdeas: [], excludeAngles: [] });
    expect(r.output.ideas).toHaveLength(10);
    expect(new Set(r.output.ideas.map((i) => i.angle)).size).toBe(10);
    for (const idea of r.output.ideas) expect(IdeaSchema.safeParse(idea).success).toBe(true);
  });

  it("respects excluded angles", async () => {
    const r = await provider().run(ideaGenerationTask, { brief, count: 6, previousIdeas: [], excludeAngles: ["contrast", "stat-led"] });
    expect(r.output.ideas.some((i) => i.angle === "contrast" || i.angle === "stat-led")).toBe(false);
  });

  it("builds a valid mock idea for every angle", () => {
    for (const angle of IDEA_ANGLES) {
      const idea = buildMockIdea(brief, angle, 0);
      const parsed = IdeaSchema.safeParse(idea);
      expect(parsed.success, angle).toBe(true);
      expect(idea.angle).toBe(angle);
      expect(idea.formats.length).toBeGreaterThan(0);
    }
  });

  it("the prompt includes the brief's key facts and constraints", () => {
    const prompt = ideaGenerationTask.prompt({ brief, count: 5, previousIdeas: ["Old idea"], excludeAngles: ["letter"] });
    expect(prompt).toContain("Hearthline");
    expect(prompt).toContain("£30");
    expect(prompt).toContain("Old idea");
    expect(prompt).not.toMatch(/Available angles:.*\bletter\b/);
    expect(prompt).toContain("Never use: vulnerable");
  });
});

describe("idea ranking", () => {
  const ideas = IDEA_ANGLES.map((a, i) => buildMockIdea(brief, a, i));

  it("ranks all ideas with totals in [0,10] and sequential ranks", () => {
    const ranked = rankIdeas(ideas, brief);
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
    for (const r of ranked) {
      expect(r.total).toBeGreaterThanOrEqual(0);
      expect(r.total).toBeLessThanOrEqual(10);
    }
    expect(ranked[0]!.total).toBeGreaterThanOrEqual(ranked[ranked.length - 1]!.total);
  });

  it("penalises novelty when an idea resembles a previous one", () => {
    const fresh = rankIdeas(ideas, brief);
    const target = fresh.find((r) => r.angle === "contrast")!;
    const previous = [`${target.title} ${target.hook} ${target.concept}`];
    const again = rankIdeas(ideas, brief, { previousIdeas: previous });
    const penalised = again.find((r) => r.angle === "contrast")!;
    expect(penalised.scores.novelty).toBeLessThan(target.scores.novelty);
    expect(penalised.total).toBeLessThan(target.total);
  });

  it("marks in-batch duplicates and halves their score", () => {
    const dup = { ...ideas[0]!, id: "dup-1" };
    const ranked = rankIdeas([ideas[0]!, dup, ideas[1]!], brief);
    const flagged = ranked.find((r) => r.id === "dup-1")!;
    expect(flagged.duplicateOf).toBe(ideas[0]!.id);
    expect(flagged.total).toBeLessThan(ranked.find((r) => r.id === ideas[0]!.id)!.total);
  });

  it("lowers brand fit when banned words appear", () => {
    const clean = buildMockIdea(brief, "question", 0);
    const dirty = { ...clean, id: "dirty", concept: `${clean.concept} We help the elderly and vulnerable victims.` };
    const ranked = rankIdeas([clean, dirty], brief);
    expect(ranked.find((r) => r.id === "dirty")!.scores.brandFit).toBeLessThan(ranked.find((r) => r.id === clean.id)!.scores.brandFit);
  });

  it("selects diverse angles and guarantees format coverage", () => {
    const ranked = rankIdeas(ideas, brief);
    const selected = selectIdeas(ranked, 3, ["static", "video", "ugc", "landing"]);
    expect(selected.length).toBeLessThanOrEqual(4);
    expect(new Set(selected.map((s) => s.angle)).size).toBe(selected.length);
    for (const f of ["static", "video", "ugc", "landing"] as const) expect(selected.some((s) => s.formats.includes(f)), f).toBe(true);
    expect(selected.every((s) => !s.duplicateOf)).toBe(true);
  });

  it("skips duplicates when selecting", () => {
    const dup = { ...ideas[0]!, id: "dup-1" };
    const ranked = rankIdeas([ideas[0]!, dup, ideas[1]!, ideas[2]!], brief);
    const selected = selectIdeas(ranked, 3);
    expect(selected.map((s) => s.id)).not.toContain("dup-1");
  });

  it("tokenSet/jaccard behave as similarity primitives", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(tokenSet("warm home winter"), tokenSet("winter warm home"))).toBe(1);
    expect(tokenSet("the and with")).toEqual(new Set());
  });

  it("allowedFacts includes tiers, doubled tiers, proof points and Gift Aid", () => {
    const facts = allowedFacts(brief);
    expect(facts).toContain("£30");
    expect(facts).toContain("£60");
    expect(facts).toContain("Gift Aid adds 25%");
    expect(facts.some((f) => f.includes("4,200"))).toBe(true);
  });
});

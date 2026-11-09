import { describe, expect, it } from "vitest";
import { BEAT_SHARES, SCRIPT_STYLES, ScriptSchema, buildMockScript, scriptGenerationTask, scriptToMarkdown, validateScript } from "../../src/areas/scripts";
import { spokenSeconds } from "../../src/core/text";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);

describe("script generation", () => {
  it("returns one schema-valid script per request", async () => {
    const requests = [{ style: "ugc-testimonial", targetSeconds: 30 }, { style: "founder-direct", targetSeconds: 15 }] as const;
    const r = await provider().run(scriptGenerationTask, { brief, idea, copy, requests: [...requests] });
    expect(r.output.scripts).toHaveLength(2);
    for (const s of r.output.scripts) expect(ScriptSchema.safeParse(s).success).toBe(true);
    expect(r.output.scripts[0]!.style).toBe("ugc-testimonial");
    expect(r.output.scripts[1]!.targetSeconds).toBe(15);
  });

  it("beat shares sum to 1 for every duration", () => {
    for (const shares of Object.values(BEAT_SHARES)) {
      const total = Object.values(shares).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("every style at every duration passes QA with no blockers", () => {
    for (const style of SCRIPT_STYLES) {
      for (const target of [15, 30, 60] as const) {
        const script = buildMockScript(brief, idea, style, target, 0);
        const report = validateScript(script, brief);
        expect(report.ok, `${style}/${target}: ${report.issues.map((i) => i.message).join("; ")}`).toBe(true);
        expect(report.issues.filter((i) => i.severity === "warn"), `${style}/${target}`).toHaveLength(0);
        const planned = script.beats.reduce((s, b) => s + b.seconds, 0);
        expect(Math.abs(planned - target)).toBeLessThanOrEqual(target * 0.15);
        const spoken = script.beats.reduce((s, b) => s + spokenSeconds(b.voiceover), 0);
        expect(spoken).toBeLessThanOrEqual(target * 1.1);
      }
    }
  });

  it("starts with a short hook and ends with a CTA", () => {
    const s = buildMockScript(brief, idea, "problem-solution", 30, 0);
    expect(s.beats[0]!.name).toBe("hook");
    expect(s.beats[0]!.voiceover.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(s.beats[s.beats.length - 1]!.name).toBe("cta");
    expect(s.beats[s.beats.length - 1]!.voiceover).toMatch(/donate|give/i);
  });

  it("flags testimonial scripts for synthetic-media disclosure but not founder scripts", () => {
    expect(buildMockScript(brief, idea, "ugc-testimonial", 30, 0).disclosureRequired).toBe(true);
    expect(buildMockScript(brief, idea, "founder-direct", 30, 0).disclosureRequired).toBe(false);
  });

  it("first-person styles speak in first person", () => {
    const ugc = buildMockScript(brief, idea, "ugc-testimonial", 30, 0);
    expect(ugc.beats.map((b) => b.voiceover).join(" ")).toMatch(/\b(I|my)\b/);
    const founder = buildMockScript(brief, idea, "founder-direct", 30, 0);
    expect(founder.beats[0]!.voiceover).toMatch(/^I run Hearthline/);
  });
});

describe("script validation", () => {
  const good = buildMockScript(brief, idea, "problem-solution", 30, 0);

  it("blocks a script with no hook", () => {
    const report = validateScript({ ...good, beats: good.beats.filter((b) => b.name !== "hook") }, brief);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("structure.hook");
  });

  it("warns when the hook is not first or the CTA is not last", () => {
    const reordered = { ...good, beats: [...good.beats.slice(1), good.beats[0]!] };
    const rules = validateScript(reordered, brief).issues.map((i) => i.rule);
    expect(rules).toContain("structure.hook-first");
    expect(rules).toContain("structure.cta-last");
  });

  it("blocks voiceover that cannot fit the duration", () => {
    const long = { ...good, beats: good.beats.map((b) => ({ ...b, voiceover: `${b.voiceover} ${"and more words to pad this out considerably".repeat(3)}` })) };
    const report = validateScript(long, brief);
    expect(report.ok).toBe(false);
    expect(report.issues.find((i) => i.rule === "duration.voiceover")?.severity).toBe("block");
  });

  it("warns when planned beat times drift from the target", () => {
    const drift = { ...good, beats: good.beats.map((b) => ({ ...b, seconds: b.seconds * 1.5 })) };
    expect(validateScript(drift, brief).issues.map((i) => i.rule)).toContain("duration.planned");
  });

  it("warns on a long hook and on over-length on-screen text", () => {
    const hook = { ...good.beats[0]!, voiceover: "word ".repeat(20).trim(), onScreenText: "x".repeat(81) };
    const rules = validateScript({ ...good, beats: [hook, ...good.beats.slice(1)] }, brief).issues.map((i) => i.rule);
    expect(rules).toContain("pacing.hook-length");
    expect(rules).toContain("beat.text-length");
  });

  it("applies the shared text guardrails to voiceover", () => {
    const bad = { ...good, beats: good.beats.map((b, i) => (i === 1 ? { ...b, voiceover: "We guarantee the elderly will be warm." } : b)) };
    const report = validateScript(bad, brief);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["claims.guarantee", "voice.avoid"]));
  });

  it("renders a markdown table with one row per beat", () => {
    const md = scriptToMarkdown(good);
    expect(md).toContain(`### ${good.title}`);
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Beat") && !l.startsWith("|---"))).toHaveLength(good.beats.length);
    expect(scriptToMarkdown(buildMockScript(brief, idea, "ugc-testimonial", 30, 0))).toContain("disclosure");
  });
});

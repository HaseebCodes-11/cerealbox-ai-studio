/**
 * Second production-breakage pass · video: captions, SRT files from editors, EDL, ffmpeg plan, executor.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEdl, buildFfmpegPlan, escapeDrawtext, escapeFilterPath, executeRenderPlan, formatSrtTime, generateSyntheticFootage, parseSrt, planDependencies, selectClipsHeuristically, splitIntoCues, toSrt, type RenderStep } from "../../src/areas/video";
import { buildMockScript } from "../../src/areas/scripts/generate";
import { sampleBrief, sampleClips, sampleIdea } from "../helpers";

const script = () => buildMockScript(sampleBrief(), sampleIdea(), "ugc-testimonial", 30, 0);

describe("L1 · SRT files as editors actually export them", () => {
  const cues = splitIntoCues("Thirty pounds keeps one older person warm for a whole week this winter.", 0, 4);
  const srt = toSrt(cues);

  it("round-trips its own output", () => {
    expect(parseSrt(srt).map((c) => c.lines)).toEqual(cues.map((c) => c.lines));
  });

  it.fails("[BUG2-28] accepts Windows CRLF line endings without leaving carriage returns in the captions", () => {
    const parsed = parseSrt(srt.replace(/\n/g, "\r\n"));
    expect(parsed).toHaveLength(cues.length);
    for (const c of parsed) for (const line of c.lines) expect(line).not.toMatch(/\r/);
  });

  it("accepts a UTF-8 byte order mark at the start of the file", () => {
    const parsed = parseSrt(`\uFEFF${srt}`);
    expect(parsed[0]!.index).toBe(1);
  });

  it("rejects WebVTT-style timings with a clear error instead of NaN times", () => {
    expect(() => parseSrt(srt.replace(/,/g, "."))).toThrow(/timing/i);
  });

  it("never emits a negative or non-monotonic timestamp even for degenerate cue windows", () => {
    for (const [s, e] of [[0, 0], [5, 2], [0.4, 0.4]] as const) {
      const out = splitIntoCues("Some words to caption here", s, e);
      for (const c of out) {
        expect(c.startSec).toBeGreaterThanOrEqual(0);
        expect(c.endSec).toBeGreaterThan(c.startSec);
        expect(formatSrtTime(c.startSec)).toMatch(/^\d{2}:\d{2}:\d{2},\d{3}$/);
      }
    }
  });

  it.fails("[BUG2-29] a 120-character word is hard-broken so no caption line exceeds the width", () => {
    const out = splitIntoCues("x".repeat(120), 0, 4);
    for (const c of out) for (const line of c.lines) expect(line.length).toBeLessThanOrEqual(42);
  });
});

describe("L2 · EDL robustness", () => {
  it("a clip shorter than its beat is used in full rather than producing a trim past its end", () => {
    const s = script();
    const clips = sampleClips().map((c) => ({ ...c, durationSec: 1.5 }));
    const sel = selectClipsHeuristically(s, clips);
    const edl = buildEdl(s, sel, clips, { brandName: "Hearthline" });
    for (const item of edl.timeline) {
      if (item.sourceOutSec === undefined || item.sourceInSec === undefined) continue;
      expect(item.sourceOutSec).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(item.sourceOutSec).toBeGreaterThan(item.sourceInSec);
    }
  });

  it("two selections for the same beat do not double the beat's time on the timeline", () => {
    const s = script();
    const clips = sampleClips();
    const sel = selectClipsHeuristically(s, clips);
    sel.selections.push({ ...sel.selections[0]! });
    const edl = buildEdl(s, sel, clips, { brandName: "Hearthline" });
    expect(edl.durationSec).toBeCloseTo(s.beats.reduce((a, b) => a + b.seconds, 0) + 2, 1);
  });

  it("an explicit null music option produces a plan with no music step", () => {
    const s = script();
    const clips = sampleClips();
    const edl = buildEdl(s, selectClipsHeuristically(s, clips), clips, { brandName: "Hearthline", music: null });
    expect(edl.music).toBeNull();
    expect(buildFfmpegPlan(edl, clips).some((st) => st.name.startsWith("music"))).toBe(false);
  });

  it("the end card and every timeline item have a brand name even when the brand contains quotes", () => {
    const s = script();
    const clips = sampleClips();
    const edl = buildEdl(s, selectClipsHeuristically(s, clips), clips, { brandName: `Jo's "Kitchen" Trust` });
    const plan = buildFfmpegPlan(edl, clips);
    const endCard = plan.find((st) => st.name === "end card")!;
    const drawtext = endCard.args.find((a) => a.includes("drawtext="))!;
    expect(drawtext).toContain("Kitchen");
    // The text option is wrapped in single quotes by design; the apostrophe inside must be escaped.
    expect(drawtext).toContain("Jo\\'s");
    const inner = drawtext.slice(drawtext.indexOf("text='") + 6, drawtext.indexOf("':fontcolor"));
    expect(inner).not.toMatch(/(?<!\\)'/);
  });
});

describe("L3 · ffmpeg filter arguments from real file systems", () => {
  it.fails("[BUG2-30] a subtitle path with an apostrophe, comma, semicolon or brackets is escaped for the filtergraph", () => {
    const p = escapeFilterPath("C:\\Users\\Jo O'Brien\\My Videos, 2026\\[final];cut.srt");
    expect(p).not.toMatch(/(?<!\\)'/);
    expect(p).not.toMatch(/(?<!\\),/);
    expect(p).not.toMatch(/(?<!\\);/);
    expect(p).not.toMatch(/(?<!\\)\[/);
    expect(p).toContain("C\\:");
  });

  it("drawtext text with every reserved character survives escaping without an unescaped quote or percent", () => {
    const out = escapeDrawtext(`100% of 'this' costs £30:00 \\ [now]; next, %{eif}`);
    expect(out).not.toMatch(/(?<!\\)'/);
    expect(out).not.toMatch(/(?<!\\)%/);
    expect(out).not.toMatch(/(?<!\\):/);
    expect(out).not.toContain("\n");
  });

  it("a work directory with spaces is carried through as a single argument", () => {
    const s = script();
    const clips = sampleClips();
    const edl = buildEdl(s, selectClipsHeuristically(s, clips), clips, { brandName: "Hearthline" });
    const plan = buildFfmpegPlan(edl, clips, { workDir: "out/My Renders 2026" });
    for (const step of plan) for (const out of step.outputs) expect(step.args).toContain(out);
  });
});

describe("L4 · executor edge cases", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "video-edge-"));
    dirs.push(d);
    return d;
  };
  const step = (name: string, inputs: string[], output: string): RenderStep => ({ name, args: ["-y", ...inputs.flatMap((i) => ["-i", i]), output], command: "", outputs: [output] });

  it("an empty plan is ok with no steps rather than hanging", async () => {
    const result = await executeRenderPlan([], { cwd: dir(), ffmpegPath: "x", runStep: async () => ({ stderr: "" }) });
    expect(result).toEqual({ ok: true, steps: [] });
  });

  it("concurrency of 0 or NaN is treated as 1", async () => {
    const plan = [step("a", [], "a.mp4"), step("b", [], "b.mp4")];
    let peak = 0;
    let active = 0;
    for (const concurrency of [0, Number.NaN, -3]) {
      const r = await executeRenderPlan(plan, {
        cwd: dir(),
        ffmpegPath: "x",
        concurrency,
        runStep: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((res) => setTimeout(res, 5));
          active--;
          return { stderr: "" };
        },
      });
      expect(r.ok).toBe(true);
    }
    expect(peak).toBe(1);
  });

  it("with failFast off, every step is attempted and the result lists each outcome in plan order", async () => {
    const plan = [step("a", [], "a.mp4"), step("b", ["a.mp4"], "b.mp4"), step("c", [], "c.mp4")];
    const r = await executeRenderPlan(plan, {
      cwd: dir(),
      ffmpegPath: "x",
      failFast: false,
      runStep: async (_b, args) => {
        if (args.includes("a.mp4") && !args.includes("b.mp4")) throw Object.assign(new Error("boom"), { stderr: "a failed" });
        return { stderr: "" };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => [s.name, s.ok])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
  });

  it("planDependencies: a step never depends on itself or on a later step", () => {
    const plan = [step("a", [], "a.mp4"), step("b", ["a.mp4"], "b.mp4"), step("c", ["b.mp4"], "c.mp4")];
    const deps = planDependencies(plan);
    deps.forEach((d, i) => {
      expect(d).not.toContain(i);
      for (const j of d) expect(j).toBeLessThan(i);
    });
  });

  it("generateSyntheticFootage with no clips and no music writes nothing and does not call ffmpeg", async () => {
    const written = await generateSyntheticFootage([], { cwd: dir(), ffmpegPath: "definitely-not-a-binary" });
    expect(written).toEqual([]);
  });
});

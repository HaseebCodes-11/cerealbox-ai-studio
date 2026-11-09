import { describe, expect, it } from "vitest";
import { buildMockScript, validateScript } from "../../src/areas/scripts";
import { buildEdl, buildFfmpegPlan, escapeDrawtext, selectClipsHeuristically, splitIntoCues, toSrt, wrapLines } from "../../src/areas/video";
import type { ClipSelection, RawClip } from "../../src/areas/video";
import { sampleBrief, sampleClips, sampleIdea } from "../helpers";

/**
 * Scenario group D: scripts come from a model, footage comes from creators'
 * phones. File names have spaces and apostrophes, transcripts have odd
 * timings, and the model will occasionally point at the wrong second.
 */
const brief = sampleBrief();
const idea = sampleIdea(brief);
const clips = sampleClips();
const script = buildMockScript(brief, idea, "ugc-testimonial", 30, 0);

describe("D1 · script durations the CLI might receive", () => {
  it("an unsupported target duration fails with a clear error instead of a TypeError", () => {
    expect(() => buildMockScript(brief, idea, "founder-direct", 45 as unknown as 15, 0)).toThrow(/15|30|60/);
  });

  it("a script with a 0-second or negative beat is rejected by validation", () => {
    const bad = { ...script, beats: script.beats.map((b, i) => (i === 2 ? { ...b, seconds: 0 } : b)) };
    const report = validateScript(bad, brief);
    expect(report.ok).toBe(false);
  });

  it("voiceover containing newlines and double spaces still times correctly", () => {
    const messy = { ...script, beats: script.beats.map((b) => ({ ...b, voiceover: b.voiceover.replace(/ /g, "  \n") })) };
    const report = validateScript(messy, brief);
    expect(report.issues.filter((i) => i.rule.startsWith("duration"))).toEqual(validateScript(script, brief).issues.filter((i) => i.rule.startsWith("duration")));
  });
});

describe("D2 · captions", () => {
  it("a single word longer than a caption line is not silently dropped or overflowed past two lines", () => {
    const cues = splitIntoCues("Supercalifragilisticexpialidociousantidisestablishmentarianism keeps you warm", 0, 4);
    const joined = cues.map((c) => c.lines.join(" ")).join(" ");
    expect(joined).toContain("Supercalifragilisticexpialidociousantidisestablishmentarianism");
    for (const c of cues) expect(c.lines.length).toBeLessThanOrEqual(2);
  });

  it("start after end produces non-negative, monotonic cues", () => {
    const cues = splitIntoCues("one two three four five six", 10, 8);
    for (const c of cues) expect(c.endSec).toBeGreaterThan(c.startSec);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startSec).toBeGreaterThanOrEqual(cues[i - 1]!.endSec - 1e-9);
  });

  it("SRT text never contains a blank line inside a cue (which would terminate the cue early)", () => {
    const cues = splitIntoCues("First part.\n\nSecond part after a blank line.", 0, 5);
    const srt = toSrt(cues);
    const blocks = srt.trim().split(/\n\s*\n/);
    expect(blocks).toHaveLength(cues.length);
  });

  it("wrapLines never returns an empty line", () => {
    for (const text of ["a", "a b", "  spaced   out  ", "x".repeat(42), "x".repeat(43)]) {
      for (const line of wrapLines(text)) expect(line.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
    }
  });
});

describe("D3 · clip selection and EDL with bad or odd inputs", () => {
  it("a selection pointing past the end of a clip never yields a negative trim", () => {
    const sel: ClipSelection = { selections: [{ beatName: "hook", clipId: "clip-01", inSec: 100, outSec: 103, reason: "model error" }], unmatchedBeats: [] };
    const edl = buildEdl(script, sel, clips, { brandName: "X" });
    const hook = edl.timeline.find((t) => t.beatName === "hook" && t.track !== "text")!;
    if (hook && hook.sourceInSec !== undefined && hook.sourceOutSec !== undefined) {
      expect(hook.sourceOutSec).toBeGreaterThan(hook.sourceInSec);
      expect(hook.sourceInSec).toBeLessThan(42);
    }
    const plan = buildFfmpegPlan(edl, clips);
    const trim = plan.find((s) => s.name.startsWith("trim hook"));
    if (trim) {
      const t = Number(trim.args[trim.args.indexOf("-t") + 1]);
      expect(t).toBeGreaterThan(0);
    }
  });

  it("a selection referencing an unknown clip falls back to a text card", () => {
    const sel: ClipSelection = { selections: [{ beatName: "hook", clipId: "ghost", inSec: 0, outSec: 3, reason: "x" }], unmatchedBeats: [] };
    const edl = buildEdl(script, sel, clips, { brandName: "X" });
    expect(edl.timeline.filter((t) => t.beatName === "hook").every((t) => t.track === "text")).toBe(true);
  });

  it("clips with zero-length or overlapping transcript segments do not break matching", () => {
    const weird: RawClip[] = [
      { id: "w1", filename: "weird.mp4", durationSec: 10, kind: "talking-head", quality: 3, tags: ["presenter"], transcript: [{ start: 5, end: 5.001, text: "quick one about older people near you" }, { start: 2, end: 9, text: "older people heat one room" }] },
    ];
    const sel = selectClipsHeuristically(script, weird);
    for (const s of sel.selections) {
      expect(s.outSec).toBeGreaterThan(s.inSec);
      expect(s.outSec).toBeLessThanOrEqual(10);
    }
  });

  it("file names with spaces, apostrophes and unicode survive into ffmpeg args verbatim", () => {
    const odd = clips.map((c) => ({ ...c, filename: `footage/Priya's take (2) – final.mp4` }));
    const sel = selectClipsHeuristically(script, odd);
    const edl = buildEdl(script, sel, odd, { brandName: "X" });
    const plan = buildFfmpegPlan(edl, odd);
    const trim = plan.find((s) => s.name.startsWith("trim"))!;
    expect(trim.args).toContain(`footage/Priya's take (2) – final.mp4`);
    expect(trim.command).toContain(`"footage/Priya's take (2) – final.mp4"`);
  });

  it("drawtext text with newlines, percent signs and backslashes is escaped so ffmpeg does not misparse", () => {
    const escaped = escapeDrawtext("Line one\nLine two 100% C:\\path");
    expect(escaped).not.toContain("\n");
    expect(escaped).toContain("\\%");
    expect(escaped).toContain("\\:");
  });

  it("a music mood that slugs to nothing still produces a usable music file name", () => {
    const edl = buildEdl(script, selectClipsHeuristically(script, clips), clips, { brandName: "X", music: { mood: "!!!" } });
    const plan = buildFfmpegPlan(edl, clips);
    const music = plan.find((s) => s.name === "music bed with ducking")!;
    const musicArg = music.args[music.args.indexOf("-stream_loop") + 3]!;
    expect(musicArg).not.toMatch(/music-\.m4a$/);
  });

  it("an EDL with no selectable footage still builds a renderable plan of text cards", () => {
    const edl = buildEdl(script, { selections: [], unmatchedBeats: script.beats.map((b) => b.name) }, [], { brandName: "X" });
    const plan = buildFfmpegPlan(edl, []);
    expect(plan.filter((s) => s.name.startsWith("text card"))).toHaveLength(script.beats.length);
    const concat = plan.find((s) => s.name === "concat")!;
    expect(concat.files![0]!.content.split("\n").filter(Boolean)).toHaveLength(script.beats.length + 1);
  });
});

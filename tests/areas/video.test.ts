import { describe, expect, it } from "vitest";
import { MAX_CHARS_PER_LINE, analysePacing, buildEdl, buildFfmpegPlan, clipSelectionTask, escapeDrawtext, formatSrtTime, parseSrt, selectClipsHeuristically, splitIntoCues, toSrt, wrapLines } from "../../src/areas/video";
import { buildMockScript } from "../../src/areas/scripts";
import { provider, sampleBrief, sampleClips, sampleIdea } from "../helpers";

const brief = sampleBrief();
const idea = sampleIdea(brief);
const script = buildMockScript(brief, idea, "ugc-testimonial", 30, 0);
const clips = sampleClips();

describe("captions", () => {
  it("splits long text into cues that respect line and length rules", () => {
    const text = "Okay honest question. When did you last check how warm your mum's house is? My nan was heating one room last winter and not telling anyone.";
    const cues = splitIntoCues(text, 0, 12);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(MAX_CHARS_PER_LINE);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.startSec).toBeCloseTo(cues[i - 1]!.endSec, 6);
    expect(cues[0]!.startSec).toBe(0);
    expect(cues[cues.length - 1]!.endSec).toBeCloseTo(12, 6);
    expect(cues.map((c) => c.lines.join(" ")).join(" ")).toBe(text);
  });

  it("returns no cues for empty text and numbers cues from the given index", () => {
    expect(splitIntoCues("   ", 0, 5)).toEqual([]);
    expect(splitIntoCues("Hello there", 3, 5, 7)[0]!.index).toBe(7);
  });

  it("balances two-line cues and never exceeds two lines", () => {
    const lines = wrapLines("A short first line then a much longer second line that keeps going");
    expect(lines.length).toBe(2);
    expect(lines[0]!.length).toBeGreaterThan(lines[1]!.length / 2);
  });

  it("formats SRT timestamps and round-trips through parseSrt", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(3661.5)).toBe("01:01:01,500");
    const cues = splitIntoCues("One two three four five six seven eight nine ten", 1.25, 6);
    const srt = toSrt(cues);
    expect(srt).toMatch(/^1\n00:00:01,250 --> /);
    const parsed = parseSrt(srt);
    expect(parsed.map((c) => c.index)).toEqual(cues.map((c) => c.index));
    expect(parsed[0]!.startSec).toBeCloseTo(1.25, 3);
    expect(parsed.map((c) => c.lines)).toEqual(cues.map((c) => c.lines));
    expect(() => parseSrt("1\nbad timing\nx")).toThrow(/Bad SRT/);
  });
});

describe("clip selection", () => {
  it("matches every beat, preferring talking-head footage for spoken beats", () => {
    const sel = selectClipsHeuristically(script, clips);
    expect(sel.unmatchedBeats).toEqual([]);
    expect(sel.selections).toHaveLength(script.beats.length);
    const hook = sel.selections.find((s) => s.beatName === "hook")!;
    expect(hook.clipId).toBe("clip-01");
    expect(hook.inSec).toBe(0);
    const turn = sel.selections.find((s) => s.beatName === "turn")!;
    expect(turn.clipId).toBe("clip-03");
    for (const s of sel.selections) {
      const beat = script.beats.find((b) => b.name === s.beatName)!;
      expect(s.outSec - s.inSec).toBeLessThanOrEqual(beat.seconds + 1e-9);
      expect(s.reason.length).toBeGreaterThan(3);
    }
  });

  it("reports unmatched beats when footage is missing", () => {
    const sel = selectClipsHeuristically(script, []);
    expect(sel.selections).toEqual([]);
    expect(sel.unmatchedBeats).toEqual(script.beats.map((b) => b.name));
  });

  it("runs through the provider as a task", async () => {
    const r = await provider().run(clipSelectionTask, { script, clips });
    expect(r.output.selections.length).toBe(script.beats.length);
    expect(clipSelectionTask.prompt({ script, clips })).toContain("clip-01");
  });
});

describe("EDL", () => {
  const selection = selectClipsHeuristically(script, clips);
  const edl = buildEdl(script, selection, clips, { brandName: brief.client.name });

  it("builds a continuous timeline ending with a branded end card", () => {
    const shots = edl.timeline.filter((t) => t.track === "video" || t.track === "broll");
    expect(shots).toHaveLength(script.beats.length);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startSec).toBeCloseTo(shots[i - 1]!.endSec, 6);
    const logo = edl.timeline.find((t) => t.track === "logo")!;
    expect(logo.text).toBe("Hearthline");
    expect(edl.durationSec).toBeCloseTo(shots[shots.length - 1]!.endSec + edl.branding.endCardSec, 6);
    expect(edl.branding.introLogoSec).toBe(0);
  });

  it("never reads past the end of a source clip", () => {
    const byId = new Map(clips.map((c) => [c.id, c]));
    for (const t of edl.timeline) {
      if (t.sourceOutSec !== undefined && t.clipId) expect(t.sourceOutSec).toBeLessThanOrEqual(byId.get(t.clipId)!.durationSec);
    }
  });

  it("generates captions covering every beat with monotonic indices", () => {
    expect(edl.captions.length).toBeGreaterThanOrEqual(script.beats.length);
    expect(edl.captions.map((c) => c.index)).toEqual(edl.captions.map((_, i) => i + 1));
    expect(edl.captions[edl.captions.length - 1]!.endSec).toBeLessThanOrEqual(edl.durationSec + 1e-6);
  });

  it("falls back to text cards for unmatched beats", () => {
    const partial = { selections: selection.selections.filter((s) => s.beatName !== "proof"), unmatchedBeats: ["proof"] };
    const e = buildEdl(script, partial, clips, { brandName: "X" });
    const proofItems = e.timeline.filter((t) => t.beatName === "proof");
    expect(proofItems.every((t) => t.track === "text")).toBe(true);
    expect(e.durationSec).toBeCloseTo(edl.durationSec, 6);
  });

  it("honours music options and export presets per aspect", () => {
    expect(edl.music?.duckDb).toBe(-12);
    expect(buildEdl(script, selection, clips, { brandName: "X", music: null }).music).toBeNull();
    expect(edl.exportPresets[0]).toMatchObject({ width: 1080, height: 1920 });
    const square = buildEdl({ ...script, aspect: "1:1" }, selection, clips, { brandName: "X" });
    expect(square.exportPresets[0]).toMatchObject({ width: 1080, height: 1080 });
  });

  it("pacing analysis is clean for the demo edit and flags slow cuts", () => {
    expect(analysePacing(edl).issues).toEqual([]);
    const slow = { ...edl, timeline: [{ track: "video" as const, clipId: "clip-01", startSec: 0, endSec: 12 }], captions: [] };
    const issues = analysePacing(slow).issues;
    expect(issues.some((i) => /First cut/.test(i))).toBe(true);
    expect(issues.some((i) => /Average shot/.test(i))).toBe(true);
    expect(issues.some((i) => /Fewer than 3/.test(i))).toBe(true);
    expect(issues.some((i) => /No captions/.test(i))).toBe(true);
  });
});

describe("ffmpeg plan", () => {
  const selection = selectClipsHeuristically(script, clips);
  const edl = buildEdl(script, selection, clips, { brandName: brief.client.name });
  const plan = buildFfmpegPlan(edl, clips);

  it("has trim steps for each shot, then end card, concat, captions, music and exports in order", () => {
    const names = plan.map((s) => s.name);
    const trims = names.filter((n) => n.startsWith("trim"));
    expect(trims).toHaveLength(script.beats.length);
    const tail = names.slice(trims.length);
    expect(tail).toEqual(["end card", "concat", "burn captions", "music bed with ducking", "export reels"]);
    for (const s of plan) {
      expect(s.command).toContain("ffmpeg");
      expect(s.outputs.length).toBeGreaterThan(0);
    }
  });

  it("uses the real source file and in/out points", () => {
    expect(plan[0]!.command).toContain("footage/priya-kitchen-take2.mp4");
    expect(plan[0]!.command).toMatch(/-ss 0 -t 3\.6/);
    expect(plan[0]!.command).toContain("scale=1080:1920");
  });

  it("skips the music step when the EDL has no music and escapes drawtext", () => {
    const noMusic = buildFfmpegPlan({ ...edl, music: null }, clips);
    expect(noMusic.map((s) => s.name)).not.toContain("music bed with ducking");
    expect(escapeDrawtext("It's 50%: ok")).toBe("It\\'s 50\\%\\: ok");
  });
});

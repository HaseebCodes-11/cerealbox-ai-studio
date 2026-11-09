import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildMockScript } from "../../src/areas/scripts";
import { buildEdl, buildFfmpegPlan, executeRenderPlan, ffmpegAvailable, generateSyntheticFootage, probeDurationSeconds, resolveFfmpeg, selectClipsHeuristically, toSrt } from "../../src/areas/video";
import { sampleBrief, sampleClips, sampleIdea } from "../helpers";

/**
 * Real render with the bundled ffmpeg: synthetic footage -> plan -> MP4.
 * Skipped only if no ffmpeg binary can be found at all.
 */
const ffmpeg = resolveFfmpeg();
const available = await ffmpegAvailable(ffmpeg ?? undefined);

describe.skipIf(!available)("video render (real ffmpeg)", () => {
  const brief = sampleBrief();
  const clips = sampleClips();
  const script = buildMockScript(brief, sampleIdea(brief), "founder-direct", 15, 0);
  const selection = selectClipsHeuristically(script, clips);
  const edl = buildEdl(script, selection, clips, { brandName: brief.client.name });
  const dir = mkdtempSync(join(tmpdir(), "cbx-render-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders the EDL to an MP4 of the right length with captions and music", async () => {
    const srtPath = `${edl.id}.srt`;
    const musicPath = "music.m4a";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, srtPath), toSrt(edl.captions));
    const plan = buildFfmpegPlan(edl, clips, { workDir: ".", srtPath, musicPath });
    const footage = await generateSyntheticFootage(clips, { cwd: dir, ffmpegPath: ffmpeg!, musicPath, musicSeconds: 30, width: 540, height: 960 });
    expect(footage.length).toBe(clips.length + 1);
    for (const f of footage) expect(statSync(f).size).toBeGreaterThan(1000);

    const result = await executeRenderPlan(plan, { cwd: dir, ffmpegPath: ffmpeg! });
    expect(result.ok, result.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.stderrTail}`).join("\n")).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(plan.map((p) => p.name));

    const final = join(dir, plan[plan.length - 1]!.outputs[0]!);
    expect(existsSync(final)).toBe(true);
    expect(statSync(final).size).toBeGreaterThan(50_000);
    const duration = await probeDurationSeconds(final, ffmpeg!);
    expect(duration).not.toBeNull();
    expect(Math.abs(duration! - edl.durationSec)).toBeLessThan(1);

    // The concat list was written by the executor and references every segment.
    const concat = readFileSync(join(dir, "concat.txt"), "utf8");
    expect(concat.split("\n").filter(Boolean)).toHaveLength(edl.timeline.filter((t) => t.track === "video" || t.track === "broll").length + 1);
  }, 180_000);

  it("reports a failing step with stderr instead of throwing", async () => {
    const bad = [{ name: "broken", args: ["-y", "-i", "does-not-exist.mp4", "x.mp4"], command: "ffmpeg …", outputs: ["x.mp4"] }];
    const result = await executeRenderPlan(bad, { cwd: dir, ffmpegPath: ffmpeg! });
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.ok).toBe(false);
    expect(result.steps[0]!.stderrTail.length).toBeGreaterThan(0);
  }, 30_000);

  it("probeDurationSeconds returns null for a missing file", async () => {
    expect(await probeDurationSeconds(join(dir, "nope.mp4"), ffmpeg!)).toBeNull();
  });
});

describe("render helpers without ffmpeg", () => {
  it("resolveFfmpeg returns a path or the bare command", () => {
    expect(typeof resolveFfmpeg()).toBe("string");
  });
  it("ffmpegAvailable is false for a bogus binary", async () => {
    expect(await ffmpegAvailable("definitely-not-ffmpeg-xyz")).toBe(false);
  });
});

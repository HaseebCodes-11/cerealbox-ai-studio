import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildMockScript } from "../../src/areas/scripts";
import { buildEdl, buildFfmpegPlan, detectFfmpegFeatures, executeRenderPlan, ffmpegAvailable, generateSyntheticFootage, probeDurationSeconds, resolveFfmpeg, selectClipsHeuristically, toSrt } from "../../src/areas/video";
import { sampleBrief, sampleClips, sampleIdea } from "../helpers";

/**
 * Real render with the bundled ffmpeg: synthetic footage -> plan -> MP4.
 * Skipped only if no ffmpeg binary can be found at all. Static builds differ
 * by platform (the Linux build lacks drawtext and libass), so the plan is
 * built from the features the binary actually reports.
 */
const ffmpeg = resolveFfmpeg();
const available = await ffmpegAvailable(ffmpeg ?? undefined);
const features = available ? await detectFfmpegFeatures(ffmpeg ?? undefined) : { drawtext: false, subtitles: false };

describe.skipIf(!available)("video render (real ffmpeg)", () => {
  const brief = sampleBrief();
  const clips = sampleClips();
  const script = buildMockScript(brief, sampleIdea(brief), "founder-direct", 15, 0);
  const selection = selectClipsHeuristically(script, clips);
  const edl = buildEdl(script, selection, clips, { brandName: brief.client.name });
  const dir = mkdtempSync(join(tmpdir(), "cbx-render-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports which optional filters the binary has", () => {
    expect(typeof features.drawtext).toBe("boolean");
    expect(typeof features.subtitles).toBe("boolean");
  });

  it("renders the EDL to an MP4 of the right length, burning captions when the build supports it", async () => {
    const srtPath = `${edl.id}.srt`;
    const musicPath = "music.m4a";
    writeFileSync(join(dir, srtPath), toSrt(edl.captions));
    const plan = buildFfmpegPlan(edl, clips, { workDir: ".", srtPath, musicPath, noText: !features.drawtext, noCaptions: !features.subtitles });
    expect(plan.some((s) => s.name === "burn captions")).toBe(features.subtitles);
    if (!features.drawtext) expect(plan.every((s) => !s.command.includes("drawtext"))).toBe(true);

    const footage = await generateSyntheticFootage(clips, { cwd: dir, ffmpegPath: ffmpeg!, musicPath, musicSeconds: 30, width: 540, height: 960, noText: !features.drawtext });
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
    // The caption sidecar always ships, burned in or not.
    expect(existsSync(join(dir, srtPath))).toBe(true);
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
  it("ffmpegAvailable and detectFfmpegFeatures are false for a bogus binary", async () => {
    expect(await ffmpegAvailable("definitely-not-ffmpeg-xyz")).toBe(false);
    expect(await detectFfmpegFeatures("definitely-not-ffmpeg-xyz")).toEqual({ drawtext: false, subtitles: false });
  });
  it("noCaptions removes the burn step and exports from the assembled cut", () => {
    const brief = sampleBrief();
    const clips = sampleClips();
    const script = buildMockScript(brief, sampleIdea(brief), "founder-direct", 15, 0);
    const edl = buildEdl(script, selectClipsHeuristically(script, clips), clips, { brandName: "X", music: null });
    const plan = buildFfmpegPlan(edl, clips, { noCaptions: true });
    expect(plan.map((s) => s.name)).not.toContain("burn captions");
    const exportStep = plan.find((s) => s.name.startsWith("export"))!;
    expect(exportStep.args[exportStep.args.indexOf("-i") + 1]).toMatch(/-assembled\.mp4$/);
  });
});

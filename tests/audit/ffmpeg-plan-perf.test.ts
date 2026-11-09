/**
 * PERF-01 guards: encoder presets on every step, dependency inference for the
 * concurrent executor, and the executor's ordering/concurrency semantics
 * (exercised through the `runStep` seam, no ffmpeg needed).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEdl, buildFfmpegPlan, EXPORT_PRESET, INTERMEDIATE_PRESET, executeRenderPlan, planDependencies, selectClipsHeuristically, type RenderStep } from "../../src/areas/video";
import { parseBrief } from "../../src/core/brief";
import { MockProvider } from "../../src/core/llm";
import { scriptGenerationTask } from "../../src/areas/scripts";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { RawClipSchema } from "../../src/areas/video";

async function samplePlan(): Promise<RenderStep[]> {
  const brief = parseBrief(JSON.parse(readFileSync("samples/brief-winter-warmth.json", "utf8")));
  const clips = z.array(RawClipSchema).parse(JSON.parse(readFileSync("samples/raw-clips.json", "utf8")));
  const provider = new MockProvider();
  const ideas = (await provider.run((await import("../../src/areas/ideas")).ideaGenerationTask, { brief, count: 3, previousIdeas: [], excludeAngles: [] })).output.ideas;
  const copy = (await provider.run((await import("../../src/areas/copy")).copyGenerationTask, { brief, idea: ideas[0]! })).output;
  const scripts = (await provider.run(scriptGenerationTask, { brief, idea: ideas[0]!, copy, requests: [{ style: "ugc-testimonial", targetSeconds: 30 }] })).output.scripts;
  const edl = buildEdl(scripts[0]!, selectClipsHeuristically(scripts[0]!, clips), clips, { brandName: brief.client.name });
  return buildFfmpegPlan(edl, clips, { workDir: "render" });
}

describe("ffmpeg plan presets", () => {
  it("uses the fast intermediate preset for every re-encoded intermediate and the export preset for exports", async () => {
    const plan = await samplePlan();
    expect(plan.length).toBeGreaterThan(5);
    for (const step of plan) {
      const i = step.args.indexOf("-preset");
      if (!step.args.includes("libx264")) continue;
      expect(i, step.name).toBeGreaterThan(-1);
      const preset = step.args[i + 1];
      if (step.name.startsWith("export ")) expect(preset, step.name).toBe(EXPORT_PRESET);
      else expect(preset, step.name).toBe(INTERMEDIATE_PRESET);
    }
    // Delivered quality is set by bitrate on exports and CRF on intermediates; both must still be present.
    expect(plan.find((s) => s.name.startsWith("export "))!.args).toContain("-b:v");
    expect(plan.find((s) => s.name.startsWith("trim "))!.args).toContain("-crf");
  });
});

describe("planDependencies", () => {
  it("lets trims and cards run together, serialises concat → captions → music → export", async () => {
    const plan = await samplePlan();
    const deps = planDependencies(plan);
    const byName = (prefix: string) => plan.findIndex((s) => s.name.startsWith(prefix));
    for (let i = 0; i < byName("concat"); i++) expect(deps[i], plan[i]!.name).toEqual([]);
    expect(deps[byName("concat")]).toEqual(Array.from({ length: byName("concat") }, (_, i) => i));
    expect(deps[byName("burn captions")]).toContain(byName("concat"));
    expect(deps[byName("music bed")]).toContain(byName("burn captions"));
    expect(deps[byName("export ")]).toContain(byName("music bed"));
  });
});

describe("executeRenderPlan concurrency", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "render-exec-"));
    dirs.push(d);
    return d;
  };
  const step = (name: string, inputs: string[], output: string): RenderStep => ({ name, args: ["-y", ...inputs.flatMap((i) => ["-i", i]), output], command: "", outputs: [output] });

  it("runs independent steps concurrently, waits for dependencies, and reports results in plan order", async () => {
    const plan = [step("a", [], "a.mp4"), step("b", [], "b.mp4"), step("c", [], "c.mp4"), step("join", ["a.mp4", "b.mp4", "c.mp4"], "join.mp4"), step("export", ["join.mp4"], "final.mp4")];
    const log: string[] = [];
    let active = 0;
    let peak = 0;
    const result = await executeRenderPlan(plan, {
      cwd: dir(),
      ffmpegPath: "fake-ffmpeg",
      concurrency: 2,
      runStep: async (_bin, args) => {
        const name = plan.find((s) => s.args === args)!.name;
        active++;
        peak = Math.max(peak, active);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, name === "a" ? 30 : 5));
        active--;
        log.push(`end ${name}`);
        return { stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["a", "b", "c", "join", "export"]);
    expect(peak).toBe(2);
    expect(log.indexOf("start join")).toBeGreaterThan(log.indexOf("end a"));
    expect(log.indexOf("start join")).toBeGreaterThan(log.indexOf("end c"));
    expect(log.indexOf("start export")).toBeGreaterThan(log.indexOf("end join"));
  });

  it("with concurrency 1 behaves exactly like the old sequential executor", async () => {
    const plan = [step("a", [], "a.mp4"), step("b", [], "b.mp4"), step("join", ["a.mp4", "b.mp4"], "join.mp4")];
    const order: string[] = [];
    const result = await executeRenderPlan(plan, { cwd: dir(), ffmpegPath: "x", concurrency: 1, runStep: async (_b, args) => (order.push(plan.find((s) => s.args === args)!.name), { stderr: "ok" }) });
    expect(order).toEqual(["a", "b", "join"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("stops at the first failure by default and reports the failing step with stderr", async () => {
    const plan = [step("a", [], "a.mp4"), step("b", ["a.mp4"], "b.mp4"), step("c", ["b.mp4"], "c.mp4")];
    const result = await executeRenderPlan(plan, {
      cwd: dir(),
      ffmpegPath: "x",
      runStep: async (_b, args) => {
        if (args.includes("b.mp4") && !args.includes("c.mp4")) throw Object.assign(new Error("boom"), { stderr: "line1\nbad things happened" });
        return { stderr: "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(result.steps[1]!.stderrTail).toContain("bad things happened");
  });

  it("writes declared files before running the step that needs them", async () => {
    const d = dir();
    const plan: RenderStep[] = [{ name: "concat", args: ["-f", "concat", "-i", "list.txt", "out.mp4"], command: "", outputs: ["out.mp4"], files: [{ path: "list.txt", content: "file 'a.mp4'\n" }] }];
    let seen = "";
    await executeRenderPlan(plan, { cwd: d, ffmpegPath: "x", runStep: async () => ((seen = readFileSync(join(d, "list.txt"), "utf8")), { stderr: "" }) });
    expect(seen).toBe("file 'a.mp4'\n");
  });
});

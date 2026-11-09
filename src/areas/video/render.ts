import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RenderStep } from "./ffmpeg";
import type { RawClip } from "./types";

/**
 * Executes a render plan with ffmpeg. The binary comes from the bundled
 * `ffmpeg-static` package when present, otherwise from PATH. Nothing here
 * builds shell strings: every step runs as an argument list.
 */
const execFileAsync = promisify(execFile);

export function resolveFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const require = createRequire(import.meta.url);
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // not installed; fall through
  }
  return "ffmpeg"; // rely on PATH; callers should probe with ffmpegAvailable()
}

export async function ffmpegAvailable(path = resolveFfmpeg()): Promise<boolean> {
  if (!path) return false;
  try {
    await execFileAsync(path, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export interface FfmpegFeatures {
  /** drawtext needs libfreetype; absent from some static Linux builds. */
  drawtext: boolean;
  /** subtitles needs libass; absent from some static Linux builds. */
  subtitles: boolean;
}

/** Ask the binary which filters it was built with so plans can degrade gracefully. */
export async function detectFfmpegFeatures(path = resolveFfmpeg()): Promise<FfmpegFeatures> {
  if (!path) return { drawtext: false, subtitles: false };
  try {
    const { stdout } = await execFileAsync(path, ["-hide_banner", "-filters"], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const has = (name: string) => new RegExp(`\\s${name}\\s`).test(stdout);
    return { drawtext: has("drawtext"), subtitles: has("subtitles") };
  } catch {
    return { drawtext: false, subtitles: false };
  }
}

export interface ExecutedStep {
  name: string;
  ok: boolean;
  ms: number;
  stderrTail: string;
}

export interface ExecuteOptions {
  cwd: string;
  ffmpegPath?: string;
  /** Stop at the first failing step (default true). */
  failFast?: boolean;
  onStep?: (result: ExecutedStep) => void;
  /** How many independent steps may encode at once (default 2; ffmpeg is already multi-threaded). */
  concurrency?: number;
  /** Test seam: replaces the ffmpeg invocation. */
  runStep?: (ffmpeg: string, args: string[], cwd: string) => Promise<{ stderr: string }>;
}

/**
 * Which earlier steps each step must wait for. A step depends on every earlier
 * step whose output it references (by path or basename) in its args or in a
 * file it writes, and a concat step depends on everything before it. Steps
 * with no dependencies between them may run concurrently.
 */
export function planDependencies(plan: RenderStep[]): number[][] {
  const deps: number[][] = [];
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    const refs = [...step.args, ...(step.files ?? []).map((f) => f.content)].join("\n");
    const isConcat = step.args.includes("concat");
    const mine: number[] = [];
    for (let j = 0; j < i; j++) {
      if (isConcat) {
        mine.push(j);
        continue;
      }
      const outputs = plan[j]!.outputs;
      if (outputs.some((o) => refs.includes(o) || refs.includes(o.split(/[\\/]/).pop() ?? o))) mine.push(j);
    }
    deps.push(mine);
  }
  return deps;
}

export async function executeRenderPlan(plan: RenderStep[], options: ExecuteOptions): Promise<{ ok: boolean; steps: ExecutedStep[] }> {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not available");
  const run = options.runStep ?? ((bin: string, args: string[], cwd: string) => execFileAsync(bin, args, { cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true }));
  const failFast = options.failFast ?? true;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const deps = planDependencies(plan);
  mkdirSync(options.cwd, { recursive: true });

  // Results are reported in plan order whatever order the steps finish in.
  const results: Array<ExecutedStep | undefined> = new Array(plan.length);
  const done = new Set<number>();
  let failed = false;
  let next = 0;

  const execute = async (index: number): Promise<void> => {
    const step = plan[index]!;
    for (const file of step.files ?? []) {
      const target = resolveIn(options.cwd, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    for (const out of step.outputs) mkdirSync(dirname(resolveIn(options.cwd, out)), { recursive: true });
    const started = Date.now();
    try {
      const { stderr } = await run(ffmpeg, step.args, options.cwd);
      results[index] = { name: step.name, ok: true, ms: Date.now() - started, stderrTail: tail(stderr) };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
      results[index] = { name: step.name, ok: false, ms: Date.now() - started, stderrTail: tail(stderr) };
      failed = true;
    }
    done.add(index);
    options.onStep?.(results[index]!);
  };

  // Steps are started strictly in plan order; a step starts once every step it depends on has finished.
  const running = new Map<number, Promise<void>>();
  while (next < plan.length || running.size > 0) {
    if (failed && failFast) break;
    while (next < plan.length && running.size < concurrency && deps[next]!.every((d) => done.has(d)) && !(failed && failFast)) {
      const index = next++;
      const p = execute(index).then(() => {
        running.delete(index);
      });
      running.set(index, p);
    }
    if (running.size === 0) {
      if (next < plan.length && !(failed && failFast)) {
        // A dependency can never be satisfied (it failed with failFast off); run the step anyway so the failure is visible in order.
        const index = next++;
        const p = execute(index).then(() => {
          running.delete(index);
        });
        running.set(index, p);
      } else break;
    }
    await Promise.race(running.values());
  }
  await Promise.all(running.values());

  const steps = results.filter((r): r is ExecutedStep => r !== undefined);
  return { ok: steps.length === plan.length && steps.every((r) => r.ok), steps };
}

/**
 * Generate stand-in footage for every clip in a manifest so a render plan
 * can be executed before real footage exists: a labelled colour test source
 * with a quiet tone, exactly the clip's duration. Also writes the music bed
 * the plan expects.
 */
export async function generateSyntheticFootage(clips: RawClip[], options: { cwd: string; ffmpegPath?: string; musicPath?: string; musicSeconds?: number; width?: number; height?: number; noText?: boolean; concurrency?: number }): Promise<string[]> {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not available");
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const written: string[] = [];
  // Stand-in footage only needs to exist and be the right length: encode it as fast as x264 allows, a few clips at a time.
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const queue = [...clips.entries()];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [index, clip] = item;
      const target = resolveIn(options.cwd, clip.filename);
      mkdirSync(dirname(target), { recursive: true });
      const hue = (index * 67) % 360;
      const vf = [`drawbox=x=0:y=0:w=iw:h=ih:color=${hslToHex(hue)}:t=fill`];
      if (!options.noText) vf.push(`drawtext=text='${clip.id}':fontcolor=white:fontsize=${Math.round(width * 0.08)}:x=(w-text_w)/2:y=(h-text_h)/2`);
      await execFileAsync(
        ffmpeg,
        ["-y", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=30:d=${clip.durationSec}`, "-f", "lavfi", "-i", `sine=frequency=${220 + index * 40}:sample_rate=48000:duration=${clip.durationSec}`, "-vf", vf.join(","), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-af", "volume=0.2", "-shortest", target],
        { cwd: options.cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
      );
      written[index] = target;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, clips.length) }, worker));
  if (options.musicPath) {
    const target = resolveIn(options.cwd, options.musicPath);
    mkdirSync(dirname(target), { recursive: true });
    const seconds = options.musicSeconds ?? 90;
    await execFileAsync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=110:sample_rate=48000:duration=${seconds}`, "-af", "volume=0.3,tremolo=f=0.5:d=0.4", "-c:a", "aac", "-ar", "48000", "-ac", "2", target], { cwd: options.cwd, windowsHide: true });
    written.push(target);
  }
  return written;
}

/** Parse the container duration from `ffmpeg -i` output (ffmpeg-static ships no ffprobe). */
export async function probeDurationSeconds(file: string, ffmpegPath = resolveFfmpeg()): Promise<number | null> {
  if (!ffmpegPath) return null;
  try {
    await execFileAsync(ffmpegPath, ["-i", file], { windowsHide: true });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
  }
  return null;
}

function resolveIn(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(join(cwd, path));
}

function tail(text: string, lines = 6): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

function hslToHex(h: number, s = 0.45, l = 0.35): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `0x${toHex(r!)}${toHex(g!)}${toHex(b!)}`;
}

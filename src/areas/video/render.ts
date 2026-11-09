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
}

export async function executeRenderPlan(plan: RenderStep[], options: ExecuteOptions): Promise<{ ok: boolean; steps: ExecutedStep[] }> {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not available");
  const results: ExecutedStep[] = [];
  mkdirSync(options.cwd, { recursive: true });
  for (const step of plan) {
    for (const file of step.files ?? []) {
      const target = resolveIn(options.cwd, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    for (const out of step.outputs) mkdirSync(dirname(resolveIn(options.cwd, out)), { recursive: true });
    const started = Date.now();
    try {
      const { stderr } = await execFileAsync(ffmpeg, step.args, { cwd: options.cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
      const result = { name: step.name, ok: true, ms: Date.now() - started, stderrTail: tail(stderr) };
      results.push(result);
      options.onStep?.(result);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
      const result = { name: step.name, ok: false, ms: Date.now() - started, stderrTail: tail(stderr) };
      results.push(result);
      options.onStep?.(result);
      if (options.failFast ?? true) return { ok: false, steps: results };
    }
  }
  return { ok: results.every((r) => r.ok), steps: results };
}

/**
 * Generate stand-in footage for every clip in a manifest so a render plan
 * can be executed before real footage exists: a labelled colour test source
 * with a quiet tone, exactly the clip's duration. Also writes the music bed
 * the plan expects.
 */
export async function generateSyntheticFootage(clips: RawClip[], options: { cwd: string; ffmpegPath?: string; musicPath?: string; musicSeconds?: number; width?: number; height?: number; noText?: boolean }): Promise<string[]> {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not available");
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const written: string[] = [];
  for (const [index, clip] of clips.entries()) {
    const target = resolveIn(options.cwd, clip.filename);
    mkdirSync(dirname(target), { recursive: true });
    const hue = (index * 67) % 360;
    const colour = `hsl(${hue},45%,35%)`;
    const vf = [`drawbox=x=0:y=0:w=iw:h=ih:color=${hslToHex(hue)}:t=fill`];
    if (!options.noText) vf.push(`drawtext=text='${clip.id}':fontcolor=white:fontsize=${Math.round(width * 0.08)}:x=(w-text_w)/2:y=(h-text_h)/2`);
    void colour;
    await execFileAsync(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=30:d=${clip.durationSec}`, "-f", "lavfi", "-i", `sine=frequency=${220 + index * 40}:sample_rate=48000:duration=${clip.durationSec}`, "-vf", vf.join(","), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-af", "volume=0.2", "-shortest", target],
      { cwd: options.cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
    );
    written.push(target);
  }
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

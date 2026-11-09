import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseBrief, type CampaignBrief } from "../core/brief";
import { RawClipSchema, type RawClip } from "../areas/video/types";

export function loadBrief(path = "samples/brief-winter-warmth.json"): CampaignBrief {
  return parseBrief(JSON.parse(readFileSync(path, "utf8")));
}

export function loadClips(path = "samples/raw-clips.json"): RawClip[] {
  if (!existsSync(path)) return [];
  return z.array(RawClipSchema).parse(JSON.parse(readFileSync(path, "utf8")));
}

export function outDir(...segments: string[]): string {
  const base = process.env.OUT_DIR ?? "out";
  const dir = join(base, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeOut(path: string, content: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function heading(text: string): void {
  console.log(`\n${"=".repeat(text.length + 4)}\n  ${text}\n${"=".repeat(text.length + 4)}`);
}

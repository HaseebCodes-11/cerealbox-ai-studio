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

/** Print a one-line usage error and exit 2 (no stack trace for predictable operator mistakes). */
export function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

/** A --name date argument that must be a real YYYY-MM-DD date. */
export function dateArg(name: string, fallback: string): string {
  const value = arg(name, fallback)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`--${name} must be a date in YYYY-MM-DD format, got "${value}"`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`--${name} is not a real calendar date: "${value}"`);
  return value;
}

/** A --name argument restricted to a fixed set of values. */
export function choiceArg<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = arg(name, fallback)!;
  if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  return value as T;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function heading(text: string): void {
  console.log(`\n${"=".repeat(text.length + 4)}\n  ${text}\n${"=".repeat(text.length + 4)}`);
}

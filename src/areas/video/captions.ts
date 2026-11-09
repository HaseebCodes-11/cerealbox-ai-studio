import type { CaptionCue } from "./types";

/**
 * Caption generation. Rules follow broadcast/social best practice:
 * max 2 lines, max 42 characters per line, cue duration 1-6 seconds,
 * roughly proportional to word count.
 */
export const MAX_CHARS_PER_LINE = 42;
export const MAX_LINES = 2;
export const MIN_CUE_SEC = 1;
export const MAX_CUE_SEC = 6;

export function splitIntoCues(text: string, startSec: number, endSec: number, startIndex = 1): CaptionCue[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  const maxChunkChars = MAX_CHARS_PER_LINE * MAX_LINES;
  for (const word of words) {
    const extra = current.length ? word.length + 1 : word.length;
    if (currentLen + extra > maxChunkChars && current.length) {
      chunks.push(current);
      current = [word];
      currentLen = word.length;
    } else {
      current.push(word);
      currentLen += extra;
    }
  }
  if (current.length) chunks.push(current);

  const totalWords = words.length;
  const span = Math.max(endSec - startSec, MIN_CUE_SEC * chunks.length);
  const cues: CaptionCue[] = [];
  let cursor = startSec;
  chunks.forEach((chunk, i) => {
    const share = chunk.length / totalWords;
    let duration = span * share;
    duration = Math.max(MIN_CUE_SEC, Math.min(MAX_CUE_SEC, duration));
    const cueEnd = i === chunks.length - 1 ? Math.max(cursor + MIN_CUE_SEC, startSec + span) : cursor + duration;
    cues.push({ index: startIndex + i, startSec: round(cursor), endSec: round(cueEnd), lines: wrapLines(chunk.join(" ")) });
    cursor = cueEnd;
  });
  return cues;
}

export function wrapLines(text: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > MAX_CHARS_PER_LINE && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // Balance two-line cues so the first line is not a single orphaned word.
  if (lines.length === 2 && lines[0]!.length < lines[1]!.length / 2) {
    const all = text.split(/\s+/);
    const mid = Math.ceil(all.length / 2);
    const a = all.slice(0, mid).join(" ");
    const b = all.slice(mid).join(" ");
    if (a.length <= MAX_CHARS_PER_LINE && b.length <= MAX_CHARS_PER_LINE) return [a, b];
  }
  return lines.slice(0, MAX_LINES);
}

export function formatSrtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(milli).padStart(3, "0")}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((c) => `${c.index}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.lines.join("\n")}`)
    .join("\n\n")
    .concat("\n");
}

export function parseSrt(srt: string): CaptionCue[] {
  const blocks = srt.trim().split(/\n\s*\n/);
  return blocks.map((block) => {
    const [idx, timing, ...lines] = block.split("\n");
    const match = timing?.match(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/);
    if (!match) throw new Error(`Bad SRT timing line: ${timing}`);
    const toSec = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    return {
      index: Number(idx),
      startSec: toSec(match[1]!, match[2]!, match[3]!, match[4]!),
      endSec: toSec(match[5]!, match[6]!, match[7]!, match[8]!),
      lines,
    };
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

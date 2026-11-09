import { defineTask } from "../../core/llm/provider";
import { tokenSet, jaccard } from "../ideas/scoring";
import type { Script } from "../scripts/types";
import { splitIntoCues } from "./captions";
import { ClipSelectionSchema, type ClipSelection, type Edl, type RawClip, type TimelineItem } from "./types";

export interface ClipSelectionInput {
  script: Script;
  clips: RawClip[];
}

const SYSTEM = `You are a video editor assembling a short-form charity ad from raw, transcribed footage.
For each beat in the script choose the clip and in/out points that best deliver the beat's voiceover or visual, preferring higher technical quality and talking-head clips for spoken beats, b-roll for visual beats.
Never choose a segment longer than the beat's duration. Explain each choice briefly. List beats you could not match so a human can fill the gap.`;

/** AI step: match script beats to footage using transcripts and tags. */
export const clipSelectionTask = defineTask<ClipSelectionInput, ClipSelection>({
  name: "video.selectClips",
  description: "Select clip segments for each script beat",
  schema: ClipSelectionSchema,
  system: SYSTEM,
  effort: "medium",
  prompt: ({ script, clips }) =>
    [
      `Script: ${script.title} (${script.targetSeconds}s, ${script.aspect}).`,
      `Beats:`,
      ...script.beats.map((b) => `- ${b.name} (${b.seconds}s): VO "${b.voiceover}" | visual: ${b.visual} | b-roll: ${b.brollKeywords.join(", ")}`),
      `Clips:`,
      ...clips.map((c) => `- ${c.id} ${c.kind} ${c.durationSec}s q${c.quality} tags[${c.tags.join(", ")}] transcript: ${c.transcript.map((t) => `[${t.start}-${t.end}] ${t.text}`).join(" ")}`),
    ].join("\n"),
  mock: ({ script, clips }) => selectClipsHeuristically(script, clips),
});

/** Deterministic fallback used by the mock and as a sanity baseline for the model. */
export function selectClipsHeuristically(script: Script, clips: RawClip[]): ClipSelection {
  const selections: ClipSelection["selections"] = [];
  const unmatchedBeats: string[] = [];
  const used = new Map<string, number>();

  for (const beat of script.beats) {
    const wantsTalkingHead = beat.name === "hook" || beat.name === "cta" || beat.name === "turn";
    const beatTokens = tokenSet(`${beat.voiceover} ${beat.visual} ${beat.brollKeywords.join(" ")}`);
    let best: { clip: RawClip; score: number; inSec: number; outSec: number } | null = null;

    for (const clip of clips) {
      const kindBonus = wantsTalkingHead ? (clip.kind === "talking-head" ? 0.3 : 0) : clip.kind === "broll" ? 0.3 : 0;
      const tagScore = jaccard(beatTokens, tokenSet(clip.tags.join(" ")));
      let transcriptScore = 0;
      let inSec = 0;
      for (const seg of clip.transcript) {
        const s = jaccard(beatTokens, tokenSet(seg.text));
        if (s > transcriptScore) {
          transcriptScore = s;
          inSec = seg.start;
        }
      }
      const reuse = used.get(clip.id) ?? 0;
      const score = kindBonus + tagScore + transcriptScore * 1.5 + clip.quality * 0.05 - reuse * 0.2;
      const outSec = Math.min(clip.durationSec, inSec + beat.seconds);
      if (outSec - inSec < Math.min(1, beat.seconds)) continue;
      if (!best || score > best.score) best = { clip, score, inSec, outSec };
    }

    if (!best || best.score < 0.2) {
      unmatchedBeats.push(beat.name);
      continue;
    }
    used.set(best.clip.id, (used.get(best.clip.id) ?? 0) + 1);
    selections.push({
      beatName: beat.name,
      clipId: best.clip.id,
      inSec: round(best.inSec),
      outSec: round(best.outSec),
      reason: `${best.clip.kind} clip, quality ${best.clip.quality}, matched on ${best.clip.tags.slice(0, 2).join("/") || "transcript"}`,
    });
  }
  return { selections, unmatchedBeats };
}

export interface EdlOptions {
  brandName: string;
  fps?: number;
  music?: { mood: string } | null;
}

/** Deterministic assembly of the Edit Decision List from script + selections. */
export function buildEdl(script: Script, selection: ClipSelection, clips: RawClip[], options: EdlOptions): Edl {
  const fps = options.fps ?? 30;
  const timeline: TimelineItem[] = [];
  const captions = [] as Edl["captions"];
  const clipById = new Map(clips.map((c) => [c.id, c]));
  let cursor = 0;
  let cueIndex = 1;

  const introLogoSec = 0; // Hook first; logo at the end only. Brand up front kills retention.
  for (const beat of script.beats) {
    const sel = selection.selections.find((s) => s.beatName === beat.name);
    const start = cursor;
    const end = round(cursor + beat.seconds);
    if (sel && clipById.has(sel.clipId)) {
      const clip = clipById.get(sel.clipId)!;
      // Clamp a selection the model placed past the end of the clip so the trim is never empty or negative.
      const need = Math.min(beat.seconds, clip.durationSec);
      const srcIn = Math.max(0, Math.min(sel.inSec, clip.durationSec - need));
      const srcOut = Math.max(srcIn + Math.min(need, 0.5), Math.min(Math.max(sel.outSec, srcIn + need), srcIn + beat.seconds, clip.durationSec));
      timeline.push({ track: clip.kind === "broll" ? "broll" : "video", clipId: sel.clipId, startSec: start, endSec: end, sourceInSec: round(srcIn), sourceOutSec: round(srcOut), beatName: beat.name });
    } else {
      // Gap filler: a branded text card so the cut is still watchable while footage is sourced.
      timeline.push({ track: "text", card: true, startSec: start, endSec: end, text: beat.onScreenText || beat.voiceover, beatName: beat.name });
    }
    if (beat.onScreenText) {
      timeline.push({ track: "text", startSec: start, endSec: end, text: beat.onScreenText, beatName: beat.name });
    }
    const cues = splitIntoCues(beat.voiceover, start, end, cueIndex);
    cueIndex += cues.length;
    captions.push(...cues);
    cursor = end;
  }

  const endCardSec = 2;
  timeline.push({ track: "logo", startSec: cursor, endSec: round(cursor + endCardSec), text: options.brandName });
  const durationSec = round(cursor + endCardSec);
  const aspect = script.aspect;
  const presets = aspect === "9:16"
    ? [{ name: "reels", width: 1080, height: 1920, bitrateKbps: 8000 }]
    : aspect === "1:1"
      ? [{ name: "feed-square", width: 1080, height: 1080, bitrateKbps: 6000 }]
      : [{ name: "landscape", width: 1920, height: 1080, bitrateKbps: 8000 }];

  return {
    id: `edl-${script.id}`,
    scriptId: script.id,
    aspect,
    fps,
    durationSec,
    timeline,
    captions,
    music: options.music === null ? null : { mood: options.music?.mood ?? script.musicMood, duckDb: -12, fadeOutSec: 1.5 },
    branding: { introLogoSec, endCardSec, endCardText: `${options.brandName} · Donate today` },
    exportPresets: presets,
  };
}

export interface PacingReport {
  averageShotSec: number;
  firstCutAtSec: number;
  shotCount: number;
  issues: string[];
}

/** Pacing heuristics for Reels: first cut within 3s, average shot 2-4s for a 30s ad. */
export function analysePacing(edl: Edl): PacingReport {
  const shots = edl.timeline.filter((t) => t.track === "video" || t.track === "broll");
  const shotCount = shots.length;
  const averageShotSec = shotCount ? round(shots.reduce((s, t) => s + (t.endSec - t.startSec), 0) / shotCount) : 0;
  const firstCutAtSec = shots[0] ? shots[0].endSec : edl.durationSec;
  const issues: string[] = [];
  if (firstCutAtSec > 4) issues.push(`First cut at ${firstCutAtSec}s; hook should cut within 3-4s.`);
  if (averageShotSec > 5) issues.push(`Average shot ${averageShotSec}s is slow for short-form.`);
  if (shotCount < 3) issues.push("Fewer than 3 shots; consider b-roll inserts.");
  if (edl.captions.length === 0) issues.push("No captions; most feed video is watched muted.");
  return { averageShotSec, firstCutAtSec, shotCount, issues };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

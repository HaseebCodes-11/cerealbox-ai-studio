import { z } from "zod";

/** A raw clip as it arrives from a shoot or a creator, after transcription. */
export const TranscriptSegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string(),
});

export const RawClipSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  durationSec: z.number().positive(),
  transcript: z.array(TranscriptSegmentSchema).default([]),
  tags: z.array(z.string()).default([]),
  /** 1-5 technical quality score from the ingest step (focus, exposure, audio). */
  quality: z.number().min(1).max(5),
  kind: z.enum(["talking-head", "broll", "screen", "graphic"]),
});

export const ClipSelectionSchema = z.object({
  selections: z.array(
    z.object({
      beatName: z.string().min(1),
      clipId: z.string().min(1),
      inSec: z.number().nonnegative(),
      outSec: z.number().positive(),
      reason: z.string().min(3),
    }),
  ),
  unmatchedBeats: z.array(z.string()).default([]),
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type RawClip = z.infer<typeof RawClipSchema>;
export type ClipSelection = z.infer<typeof ClipSelectionSchema>;

export interface TimelineItem {
  track: "video" | "broll" | "text" | "logo";
  /** A text item that stands in for missing footage (rendered as a card), as opposed to an overlay. */
  card?: boolean;
  clipId?: string;
  startSec: number;
  endSec: number;
  sourceInSec?: number;
  sourceOutSec?: number;
  text?: string;
  beatName?: string;
}

export interface CaptionCue {
  index: number;
  startSec: number;
  endSec: number;
  lines: string[];
}

export interface Edl {
  id: string;
  scriptId: string;
  aspect: "9:16" | "1:1" | "16:9";
  fps: number;
  durationSec: number;
  timeline: TimelineItem[];
  captions: CaptionCue[];
  music: { mood: string; duckDb: number; fadeOutSec: number } | null;
  branding: { introLogoSec: number; endCardSec: number; endCardText: string };
  exportPresets: Array<{ name: string; width: number; height: number; bitrateKbps: number }>;
}

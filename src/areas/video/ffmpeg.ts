import type { Edl, RawClip } from "./types";

/**
 * Turn an EDL into an ffmpeg render plan: one trim per shot, text cards for
 * gaps, an end card, concat, caption burn-in, music bed with ducking and
 * per-preset exports. Each step carries structured args (so a worker can
 * execute it safely without a shell) plus a human-readable command string
 * for review and logging. Files a step needs (the concat list) are declared
 * so the executor writes them first.
 */
export interface RenderStep {
  name: string;
  args: string[];
  /** Display form of the step, equivalent to `ffmpeg ${args}`. */
  command: string;
  outputs: string[];
  files?: Array<{ path: string; content: string }>;
}

export interface PlanOptions {
  workDir?: string;
  srtPath?: string;
  /** Path of the music bed; defaults to <workDir>/music-<mood>.m4a. */
  musicPath?: string;
  /** Replace the drawtext filter with plain colour cards (for ffmpeg builds without libfreetype). */
  noText?: boolean;
  /** Skip burning captions (for ffmpeg builds without libass); the SRT sidecar still ships. */
  noCaptions?: boolean;
}

const AUDIO = ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k"];

export function buildFfmpegPlan(edl: Edl, clips: RawClip[], options: PlanOptions = {}): RenderStep[] {
  const workDir = options.workDir ?? "render";
  const srtPath = options.srtPath ?? `${workDir}/${edl.id}.srt`;
  const clipById = new Map(clips.map((c) => [c.id, c]));
  const steps: RenderStep[] = [];
  const segmentFiles: string[] = [];
  const { width, height } = edl.exportPresets[0] ?? { width: 1080, height: 1920 };
  const step = (name: string, args: string[], outputs: string[], files?: RenderStep["files"]): RenderStep => ({
    name,
    args,
    command: `ffmpeg ${args.map(quote).join(" ")}`,
    outputs,
    ...(files ? { files } : {}),
  });
  const card = (text: string, colour: string, duration: number, out: string, label: string) => {
    const filters = [`drawbox=x=0:y=0:w=iw:h=ih:color=${colour}:t=fill`];
    if (!options.noText && text) filters.push(`drawtext=text='${escapeDrawtext(text)}':fontcolor=white:fontsize=${Math.round(width * 0.06)}:x=(w-text_w)/2:y=(h-text_h)/2`);
    return step(
      label,
      ["-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${width}x${height}:d=${duration}:r=${edl.fps}`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-vf", filters.join(","), "-t", String(duration), "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", ...AUDIO, "-shortest", out],
      [out],
    );
  };

  let i = 0;
  for (const item of edl.timeline) {
    if (item.track !== "video" && item.track !== "broll") continue;
    const clip = item.clipId ? clipById.get(item.clipId) : undefined;
    const out = `${workDir}/seg-${String(i).padStart(2, "0")}.mp4`;
    const duration = round(item.endSec - item.startSec);
    if (clip && item.sourceInSec !== undefined) {
      steps.push(
        step(
          `trim ${item.beatName ?? i} from ${clip.id}`,
          ["-y", "-ss", String(item.sourceInSec), "-t", String(duration), "-i", clip.filename, "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${edl.fps}`, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", ...AUDIO, out],
          [out],
        ),
      );
    } else {
      steps.push(card(item.text ?? "", "0x2B3A4A", duration, out, `text card ${item.beatName ?? i}`));
    }
    segmentFiles.push(out);
    i++;
  }

  const endCard = `${workDir}/end-card.mp4`;
  steps.push(card(edl.branding.endCardText, "0xC8442B", edl.branding.endCardSec, endCard, "end card"));
  segmentFiles.push(endCard);

  const concatList = `${workDir}/concat.txt`;
  const assembled = `${workDir}/${edl.id}-assembled.mp4`;
  steps.push(
    step("concat", ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", ...AUDIO, assembled], [concatList, assembled], [
      { path: concatList, content: segmentFiles.map((f) => `file '${basename(f)}'`).join("\n") + "\n" },
    ]),
  );

  let current = assembled;
  if (!options.noCaptions) {
    const captioned = `${workDir}/${edl.id}-captioned.mp4`;
    steps.push(
      step(
        "burn captions",
        // SRT is converted to ASS with PlayRes 384x288, so style values are in those units and libass scales them to the frame.
        ["-y", "-i", assembled, "-vf", `subtitles=${escapeFilterPath(srtPath)}:force_style='${captionStyle(width, height)}'`, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", captioned],
        [captioned],
      ),
    );
    current = captioned;
  }
  if (edl.music) {
    const mixed = `${workDir}/${edl.id}-mixed.mp4`;
    const musicPath = options.musicPath ?? `${workDir}/music-${slug(edl.music.mood)}.m4a`;
    steps.push(
      step(
        "music bed with ducking",
        [
          "-y",
          "-i",
          current,
          "-stream_loop",
          "-1",
          "-i",
          musicPath,
          "-filter_complex",
          `[1:a]volume=${edl.music.duckDb}dB,afade=t=out:st=${round(Math.max(0, edl.durationSec - edl.music.fadeOutSec))}:d=${edl.music.fadeOutSec}[m];[m][0:a]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[ducked];[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2[a]`,
          "-map",
          "0:v",
          "-map",
          "[a]",
          "-c:v",
          "copy",
          ...AUDIO,
          "-shortest",
          mixed,
        ],
        [mixed],
      ),
    );
    current = mixed;
  }

  for (const preset of edl.exportPresets) {
    const out = `${workDir}/${edl.id}-${preset.name}.mp4`;
    steps.push(step(`export ${preset.name}`, ["-y", "-i", current, "-vf", `scale=${preset.width}:${preset.height}`, "-c:v", "libx264", "-b:v", `${preset.bitrateKbps}k`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...AUDIO, out], [out]));
  }

  return steps;
}

/** libass default script resolution for converted SRT files. */
export const ASS_PLAY_RES = { x: 384, y: 288 } as const;

/**
 * Caption style in ASS units: ~3.2% of frame height for the font, bottom-centre
 * alignment, a bottom margin clear of the Reels UI (14%) and side margins (6%).
 */
export function captionStyle(width: number, height: number): string {
  const fontSize = Math.max(8, Math.round(ASS_PLAY_RES.y * 0.032));
  const marginV = Math.round(ASS_PLAY_RES.y * 0.14);
  const marginH = Math.round(ASS_PLAY_RES.x * 0.06);
  void width;
  void height;
  return `FontName=Arial,FontSize=${fontSize},Bold=1,Outline=2,Shadow=0,Alignment=2,MarginV=${marginV},MarginL=${marginH},MarginR=${marginH}`;
}

export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

/** The subtitles filter parses ':' and '\' specially; Windows drive letters need escaping. */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function quote(arg: string): string {
  return /[\s"'$&|<>()[\]{};\\]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

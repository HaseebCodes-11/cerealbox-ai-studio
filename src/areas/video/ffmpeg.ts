import type { Edl, RawClip } from "./types";

/**
 * Turn an EDL into an ffmpeg render plan: one trim command per shot, a concat
 * step, caption burn-in, end card and per-preset exports. Commands are strings
 * so they can be reviewed, logged and run by a worker (or handed to a cloud
 * renderer). We deliberately do not shell out here.
 */
export interface RenderStep {
  name: string;
  command: string;
  outputs: string[];
}

export function buildFfmpegPlan(edl: Edl, clips: RawClip[], options: { workDir?: string; srtPath?: string } = {}): RenderStep[] {
  const workDir = options.workDir ?? "render";
  const srtPath = options.srtPath ?? `${workDir}/${edl.id}.srt`;
  const clipById = new Map(clips.map((c) => [c.id, c]));
  const steps: RenderStep[] = [];
  const segmentFiles: string[] = [];
  const { width, height } = edl.exportPresets[0] ?? { width: 1080, height: 1920 };

  let i = 0;
  for (const item of edl.timeline) {
    if (item.track !== "video" && item.track !== "broll") continue;
    const clip = item.clipId ? clipById.get(item.clipId) : undefined;
    const out = `${workDir}/seg-${String(i).padStart(2, "0")}.mp4`;
    const duration = round(item.endSec - item.startSec);
    if (clip && item.sourceInSec !== undefined) {
      steps.push({
        name: `trim ${item.beatName ?? i} from ${clip.id}`,
        command: `ffmpeg -y -ss ${item.sourceInSec} -t ${duration} -i "${clip.filename}" -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${edl.fps}" -c:v libx264 -preset fast -crf 20 -c:a aac "${out}"`,
        outputs: [out],
      });
    } else {
      steps.push({
        name: `text card ${item.beatName ?? i}`,
        command: `ffmpeg -y -f lavfi -i color=c=0x2B3A4A:s=${width}x${height}:d=${duration}:r=${edl.fps} -vf "drawtext=text='${escapeDrawtext(item.text ?? "")}':fontcolor=white:fontsize=${Math.round(width * 0.06)}:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -t ${duration} "${out}"`,
        outputs: [out],
      });
    }
    segmentFiles.push(out);
    i++;
  }

  const endCard = `${workDir}/end-card.mp4`;
  steps.push({
    name: "end card",
    command: `ffmpeg -y -f lavfi -i color=c=0xC8442B:s=${width}x${height}:d=${edl.branding.endCardSec}:r=${edl.fps} -vf "drawtext=text='${escapeDrawtext(edl.branding.endCardText)}':fontcolor=white:fontsize=${Math.round(width * 0.07)}:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 "${endCard}"`,
    outputs: [endCard],
  });
  segmentFiles.push(endCard);

  const concatList = `${workDir}/concat.txt`;
  const assembled = `${workDir}/${edl.id}-assembled.mp4`;
  steps.push({
    name: "concat",
    command: `printf "${segmentFiles.map((f) => `file '${f}'\\n`).join("")}" > "${concatList}" && ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${assembled}"`,
    outputs: [concatList, assembled],
  });

  const captioned = `${workDir}/${edl.id}-captioned.mp4`;
  steps.push({
    name: "burn captions",
    command: `ffmpeg -y -i "${assembled}" -vf "subtitles='${srtPath}':force_style='FontName=Arial,FontSize=18,Bold=1,Outline=2,MarginV=${Math.round(height * 0.12)}'" -c:a copy "${captioned}"`,
    outputs: [captioned],
  });

  let current = captioned;
  if (edl.music) {
    const mixed = `${workDir}/${edl.id}-mixed.mp4`;
    steps.push({
      name: "music bed with ducking",
      command: `ffmpeg -y -i "${current}" -i "${workDir}/music-${slug(edl.music.mood)}.mp3" -filter_complex "[1:a]volume=${edl.music.duckDb}dB,afade=t=out:st=${round(edl.durationSec - edl.music.fadeOutSec)}:d=${edl.music.fadeOutSec}[m];[0:a][m]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[a]" -map 0:v -map "[a]" -shortest "${mixed}"`,
      outputs: [mixed],
    });
    current = mixed;
  }

  for (const preset of edl.exportPresets) {
    const out = `${workDir}/${edl.id}-${preset.name}.mp4`;
    steps.push({
      name: `export ${preset.name}`,
      command: `ffmpeg -y -i "${current}" -vf "scale=${preset.width}:${preset.height}" -c:v libx264 -b:v ${preset.bitrateKbps}k -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k "${out}"`,
      outputs: [out],
    });
  }

  return steps;
}

export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

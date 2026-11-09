import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { RawClipSchema, generateSyntheticFootage, resolveFfmpeg, detectFfmpegFeatures } from "../src/areas/video/index";

const clips = z.array(RawClipSchema).parse(JSON.parse(readFileSync("samples/raw-clips.json", "utf8")));
const ffmpeg = resolveFfmpeg()!;
const features = await detectFfmpegFeatures(ffmpeg);
console.log(`${clips.length} clips, total ${clips.reduce((s, c) => s + c.durationSec, 0)} s of footage`);
for (const [w, h, conc] of [[1080, 1920, 3], [1080, 1920, 1], [540, 960, 3]] as const) {
  const dir = mkdtempSync(join(tmpdir(), "synth-"));
  const t = Date.now();
  await generateSyntheticFootage(clips, { cwd: dir, ffmpegPath: ffmpeg, musicPath: "music.m4a", musicSeconds: 40, width: w, height: h, noText: !features.drawtext, concurrency: conc });
  console.log(`${w}x${h} concurrency ${conc}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  rmSync(dir, { recursive: true, force: true });
}

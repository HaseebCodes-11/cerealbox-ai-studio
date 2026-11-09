/**
 * Video render CLI: script -> clip selection -> EDL -> captions -> ffmpeg plan
 * -> real MP4, using synthetic stand-in footage generated from the clip
 * manifest (no real footage ships in the repo).
 *
 *   npm run video                         # 30s UGC script from the sample brief
 *   npm run video -- --seconds 15 --style founder-direct
 */
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { getProvider } from "../core/llm";
import { ideaGenerationTask, rankIdeas, selectIdeas } from "../areas/ideas";
import { copyGenerationTask } from "../areas/copy";
import { scriptGenerationTask, type ScriptStyle } from "../areas/scripts";
import { analysePacing, buildEdl, buildFfmpegPlan, clipSelectionTask, executeRenderPlan, ffmpegAvailable, generateSyntheticFootage, probeDurationSeconds, resolveFfmpeg, toSrt } from "../areas/video";
import { arg, heading, json, loadBrief, loadClips, outDir, writeOut } from "./shared";

async function main(): Promise<void> {
  const provider = await getProvider();
  const brief = loadBrief(arg("brief"));
  const clips = loadClips();
  const seconds = Number(arg("seconds", "30")) as 15 | 30 | 60;
  const style = (arg("style", "ugc-testimonial") as ScriptStyle) ?? "ugc-testimonial";
  const ffmpeg = resolveFfmpeg();

  heading(`Video render · ${brief.campaignName} · ${style} ${seconds}s`);
  if (!(await ffmpegAvailable(ffmpeg ?? undefined))) {
    console.error("ffmpeg is not available. Install ffmpeg or `npm install` (ffmpeg-static).");
    process.exit(2);
  }
  console.log(`ffmpeg: ${ffmpeg}`);

  const ideas = await provider.run(ideaGenerationTask, { brief, count: 10, previousIdeas: [], excludeAngles: [] });
  const idea = selectIdeas(rankIdeas(ideas.output.ideas, brief), 1, ["ugc"])[0]!;
  const copy = (await provider.run(copyGenerationTask, { brief, idea })).output;
  const script = (await provider.run(scriptGenerationTask, { brief, idea, copy, requests: [{ style, targetSeconds: seconds }] })).output.scripts[0]!;
  const selection = (await provider.run(clipSelectionTask, { script, clips })).output;
  const edl = buildEdl(script, selection, clips, { brandName: brief.client.name });

  const dir = resolve(outDir(brief.id, "06-video", "render"));
  const srtPath = `${edl.id}.srt`;
  writeOut(join(dir, srtPath), toSrt(edl.captions));
  const musicPath = `music-${edl.music ? edl.music.mood.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "none"}.m4a`;
  const plan = buildFfmpegPlan(edl, clips, { workDir: ".", srtPath, musicPath });
  writeOut(join(dir, "plan.json"), json(plan));

  console.log(`Generating synthetic footage for ${clips.length} clips…`);
  await generateSyntheticFootage(clips, { cwd: dir, ffmpegPath: ffmpeg!, musicPath, musicSeconds: Math.ceil(edl.durationSec) + 5 });

  console.log(`Executing ${plan.length} render steps…`);
  const result = await executeRenderPlan(plan, {
    cwd: dir,
    ffmpegPath: ffmpeg!,
    onStep: (s) => console.log(`  ${s.ok ? "ok " : "ERR"} ${s.name} (${s.ms} ms)${s.ok ? "" : `\n${s.stderrTail}`}`),
  });
  if (!result.ok) {
    console.error("Render failed.");
    process.exit(1);
  }
  const final = join(dir, plan[plan.length - 1]!.outputs[0]!);
  const duration = await probeDurationSeconds(final, ffmpeg!);
  const size = statSync(final).size;
  console.log(`\nFinal: ${final}\n  ${duration?.toFixed(2)}s (EDL ${edl.durationSec}s) · ${(size / 1024).toFixed(0)} KB · pacing issues: ${analysePacing(edl).issues.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

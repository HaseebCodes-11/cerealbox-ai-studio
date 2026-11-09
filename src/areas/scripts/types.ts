import { z } from "zod";

export const SCRIPT_STYLES = ["ugc-testimonial", "founder-direct", "problem-solution", "explainer", "story"] as const;
export const ScriptStyleSchema = z.enum(SCRIPT_STYLES);
export type ScriptStyle = z.infer<typeof ScriptStyleSchema>;

export const BEAT_NAMES = ["hook", "problem", "turn", "proof", "offer", "cta"] as const;
export const BeatNameSchema = z.enum(BEAT_NAMES);
export type BeatName = z.infer<typeof BeatNameSchema>;

export const BeatSchema = z.object({
  name: BeatNameSchema,
  voiceover: z.string().min(1),
  onScreenText: z.string().max(80),
  visual: z.string().min(5),
  brollKeywords: z.array(z.string()).default([]),
  seconds: z.number().positive(),
});

export const ScriptSchema = z.object({
  id: z.string().min(1),
  ideaId: z.string().min(1),
  title: z.string().min(3),
  style: ScriptStyleSchema,
  targetSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  aspect: z.enum(["9:16", "1:1", "16:9"]),
  beats: z.array(BeatSchema).min(3),
  captionStyle: z.enum(["burned-in-bold", "burned-in-subtle", "none"]),
  musicMood: z.string().min(2),
  /** True when the script will be delivered by a synthetic presenter or voice. */
  disclosureRequired: z.boolean(),
  estimatedSeconds: z.number().positive(),
});

export const ScriptBatchSchema = z.object({ scripts: z.array(ScriptSchema).min(1) });

export type Beat = z.infer<typeof BeatSchema>;
export type Script = z.infer<typeof ScriptSchema>;
export type ScriptBatch = z.infer<typeof ScriptBatchSchema>;

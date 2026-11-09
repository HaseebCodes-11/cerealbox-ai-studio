import { z } from "zod";

/**
 * UGC production manifest: everything a producer (human or API) needs to turn
 * an approved script into an influencer-style video. The manifest is the
 * contract between the AI planning step and whichever renderer we use:
 * a real creator brief, a synthetic avatar service, or a mix (real creator
 * footage + AI voice-over + AI captions).
 */

export const CreatorPersonaSchema = z.object({
  name: z.string().min(1),
  ageRange: z.string().min(1),
  description: z.string().min(10),
  voiceStyle: z.string().min(3),
  /** Whether this presenter is synthetic (AI avatar) or a real creator brief. */
  synthetic: z.boolean(),
  whyThisPersona: z.string().min(10),
});

export const ShotSchema = z.object({
  beatName: z.string().min(1),
  camera: z.string().min(3),
  setting: z.string().min(3),
  action: z.string().min(3),
  dialogue: z.string().min(1),
  onScreenText: z.string().max(80),
  props: z.array(z.string()).default([]),
  durationSec: z.number().positive(),
});

export const ApprovalGateSchema = z.object({
  gate: z.enum(["script", "persona", "rough-cut", "final"]),
  owner: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected"]),
  note: z.string().optional(),
});

export const UgcManifestSchema = z.object({
  id: z.string().min(1),
  scriptId: z.string().min(1),
  persona: CreatorPersonaSchema,
  shots: z.array(ShotSchema).min(1),
  voice: z.object({
    provider: z.enum(["real-creator", "elevenlabs", "openai-tts"]),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  avatar: z.object({
    provider: z.enum(["real-creator", "heygen", "synthesia", "none"]),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  captions: z.enum(["burned-in-bold", "burned-in-subtle", "none"]),
  aspect: z.enum(["9:16", "1:1", "16:9"]),
  deliverables: z.array(z.object({ format: z.string(), filename: z.string(), placement: z.string() })).min(1),
  disclosure: z.object({
    aiGenerated: z.boolean(),
    label: z.string(),
    metaAiDisclosureFlag: z.boolean(),
  }),
  approvals: z.array(ApprovalGateSchema).min(1),
  estimatedCostGbp: z.number().nonnegative(),
  estimatedTurnaroundHours: z.number().positive(),
});

export type CreatorPersona = z.infer<typeof CreatorPersonaSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;
export type UgcManifest = z.infer<typeof UgcManifestSchema>;

/** Minimal provider abstraction so the pipeline can swap HeyGen/Synthesia/real creators. */
export interface RenderJob {
  jobId: string;
  status: "queued" | "rendering" | "done" | "failed";
  outputUrl?: string;
  error?: string;
}

export interface UgcRenderer {
  readonly name: string;
  submit(manifest: UgcManifest): Promise<RenderJob>;
  poll(jobId: string): Promise<RenderJob>;
}

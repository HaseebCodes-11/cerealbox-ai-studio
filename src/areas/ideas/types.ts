import { z } from "zod";

/**
 * Creative angles are the "shape" of an idea. Forcing the model to pick a
 * named angle (and penalising repeats) is the single biggest lever against
 * generic output: it stops ten variations of "help us help them".
 */
export const IDEA_ANGLES = [
  "contrast", // before/after, with/without
  "stat-led", // one hard number carries the ad
  "testimonial", // a real person's words
  "myth-bust", // attack a common objection head on
  "behind-the-scenes", // show the work, the team, the van, the kit
  "urgency-match", // deadline + match funding
  "founder-direct", // straight to camera, no production
  "how-it-works", // exactly what a gift buys, step by step
  "local-pride", // place-based, "in your town"
  "unexpected-comparison", // cost of X vs cost of the gift
  "letter", // a letter from or to the person helped
  "question", // open with a question the audience is already asking
] as const;

export const IdeaAngleSchema = z.enum(IDEA_ANGLES);
export type IdeaAngle = z.infer<typeof IdeaAngleSchema>;

export const IDEA_FORMATS = ["static", "video", "ugc", "landing"] as const;
export const IdeaFormatSchema = z.enum(IDEA_FORMATS);
export type IdeaFormat = z.infer<typeof IdeaFormatSchema>;

export const IdeaScoresSchema = z.object({
  novelty: z.number().min(0).max(10),
  clarity: z.number().min(0).max(10),
  emotionalPull: z.number().min(0).max(10),
  brandFit: z.number().min(0).max(10),
  feasibility: z.number().min(0).max(10),
});

export const IdeaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3).max(80),
  angle: IdeaAngleSchema,
  hook: z.string().min(5).max(160),
  concept: z.string().min(20),
  whyItWorks: z.string().min(10),
  audienceInsight: z.string().min(5),
  formats: z.array(IdeaFormatSchema).min(1),
  visualDirection: z.string().min(5),
  riskFlags: z.array(z.string()).default([]),
  scores: IdeaScoresSchema,
});

export const IdeaBatchSchema = z.object({
  ideas: z.array(IdeaSchema).min(1),
});

export type IdeaScores = z.infer<typeof IdeaScoresSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
export type IdeaBatch = z.infer<typeof IdeaBatchSchema>;

export interface RankedIdea extends Idea {
  total: number;
  rank: number;
  duplicateOf?: string;
}

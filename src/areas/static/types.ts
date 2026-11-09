import { z } from "zod";

export const CREATIVE_FORMATS = {
  square: { width: 1080, height: 1080, placements: ["meta_feed"], label: "1:1 feed" },
  story: { width: 1080, height: 1920, placements: ["meta_stories", "meta_reels"], label: "9:16 stories/reels" },
  landscape: { width: 1200, height: 628, placements: ["meta_feed"], label: "1.91:1 link ad" },
} as const;

export type CreativeFormatName = keyof typeof CREATIVE_FORMATS;
export const CreativeFormatSchema = z.enum(["square", "story", "landscape"]);

export const LAYOUTS = ["bold-statement", "stat-led", "split-contrast", "quote"] as const;
export const LayoutSchema = z.enum(LAYOUTS);
export type Layout = z.infer<typeof LayoutSchema>;

export const CreativeSpecSchema = z.object({
  id: z.string().min(1),
  ideaId: z.string().min(1),
  layout: LayoutSchema,
  format: CreativeFormatSchema,
  headline: z.string().min(3).max(90),
  subline: z.string().max(140).optional(),
  stat: z.object({ value: z.string().min(1).max(12), label: z.string().min(3).max(60) }).optional(),
  cta: z.string().min(3).max(30),
  badge: z.string().max(40).optional(),
  /** Prompt for the image model (or brief for a photographer) describing the background photo. */
  imagePrompt: z.string().min(10),
  imageStyle: z.enum(["photo", "illustration", "flat-colour"]),
  /** Which palette roles to use so brand compliance is checkable. */
  colours: z.object({
    background: z.enum(["primary", "secondary", "accent", "background"]),
    text: z.enum(["text", "background"]),
    accent: z.enum(["primary", "secondary", "accent"]),
  }),
  notes: z.string().default(""),
});

export const CreativeBatchSchema = z.object({ specs: z.array(CreativeSpecSchema).min(1) });

export type CreativeSpec = z.infer<typeof CreativeSpecSchema>;
export type CreativeBatch = z.infer<typeof CreativeBatchSchema>;

export interface RenderedCreative {
  spec: CreativeSpec;
  svg: string;
  width: number;
  height: number;
  /** Bounding boxes of text blocks, used by the checks. */
  textBoxes: Array<{ x: number; y: number; width: number; height: number; role: string }>;
}

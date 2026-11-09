import { z } from "zod";
import { META_CTA_BUTTONS } from "./limits";

export const PrimaryTextVariantSchema = z.object({
  variant: z.enum(["short", "medium", "long"]),
  text: z.string().min(20),
  angle: z.string().min(1),
});

export const CopyPackSchema = z.object({
  hooks: z.array(z.string().min(5)).min(3),
  headlines: z.array(z.string().min(3)).min(3),
  primaryTexts: z.array(PrimaryTextVariantSchema).min(2),
  descriptions: z.array(z.string().min(3)).min(2),
  storyOverlays: z.array(z.string().min(3)).min(2),
  ctaButton: z.enum(META_CTA_BUTTONS),
  messagingPillars: z.array(z.string().min(3)).min(2),
});

export type PrimaryTextVariant = z.infer<typeof PrimaryTextVariantSchema>;
export type CopyPack = z.infer<typeof CopyPackSchema>;

import type { CampaignBrief } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import { truncate } from "../../core/text";
import type { CopyPack } from "../copy/types";
import type { Idea } from "../ideas/types";
import { CreativeBatchSchema, type CreativeBatch, type CreativeFormatName, type CreativeSpec, type Layout } from "./types";

export interface CreativeConceptInput {
  brief: CampaignBrief;
  idea: Idea;
  copy: CopyPack;
  formats: CreativeFormatName[];
}

const SYSTEM = `You are an art director producing paid-social statics for UK charities.
You turn an approved idea and copy pack into concrete creative specifications that a template renderer or designer can build without guessing.
Rules:
- Headlines under 60 characters, sublines under 120. One message per creative.
- Pick a layout that fits the angle: stat-led for numbers, split-contrast for before/after, quote for testimonials, bold-statement otherwise.
- Write an image prompt a photographer or image model can execute: subject, setting, lighting, crop, mood. No real identifiable people, no logos, no text in the image.
- Never put statistics in the creative that are not in the proof points.
- Use the brand palette roles, not arbitrary colours.`;

export const creativeConceptTask = defineTask<CreativeConceptInput, CreativeBatch>({
  name: "static.concept",
  description: "Turn an idea plus copy into renderable static creative specs",
  schema: CreativeBatchSchema,
  system: SYSTEM,
  effort: "medium",
  prompt: ({ brief, idea, copy, formats }) =>
    [
      `Client: ${brief.client.name}. Campaign: ${brief.campaignName}.`,
      `Idea: ${idea.title} (${idea.angle}). Visual direction: ${idea.visualDirection}`,
      `Approved headlines: ${copy.headlines.join(" | ")}`,
      `Approved hooks: ${copy.hooks.join(" | ")}`,
      `Story overlays: ${copy.storyOverlays.join(" | ")}`,
      `Offer tiers: ${brief.offer.donationTiers.map((t) => `${formatCurrency(t.amount, t.currency)} ${t.impact}`).join("; ")}`,
      brief.offer.matchFunding ? `Badge candidate: ${brief.offer.matchFunding}` : "",
      `Proof points: ${brief.client.proofPoints.join(" | ")}`,
      `Produce one spec per format: ${formats.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
  mock: ({ brief, idea, copy, formats }) => ({ specs: formats.map((f, i) => buildMockSpec(brief, idea, copy, f, i)) }),
});

export function layoutForAngle(angle: Idea["angle"]): Layout {
  switch (angle) {
    case "stat-led":
    case "unexpected-comparison":
    case "urgency-match":
      return "stat-led";
    case "contrast":
      return "split-contrast";
    case "testimonial":
    case "letter":
      return "quote";
    default:
      return "bold-statement";
  }
}

export function buildMockSpec(brief: CampaignBrief, idea: Idea, copy: CopyPack, format: CreativeFormatName, index: number): CreativeSpec {
  const tier = brief.offer.donationTiers[0]!;
  const amount = formatCurrency(tier.amount, tier.currency);
  const layout = layoutForAngle(idea.angle);
  const headline = truncate(copy.headlines[index % copy.headlines.length] ?? idea.title, 60);
  const subline = truncate(format === "story" ? (copy.storyOverlays[0] ?? idea.hook) : idea.hook, 120);
  const badge = brief.offer.matchFunding ? truncate(brief.offer.deadline ? `Doubled until ${brief.offer.deadline}` : "Gifts doubled", 40) : undefined;

  const spec: CreativeSpec = {
    id: `creative-${idea.id}-${format}`,
    ideaId: idea.id,
    layout,
    format,
    headline,
    cta: copy.ctaButton === "DONATE_NOW" ? `Donate ${amount}` : "Learn more",
    imagePrompt: `${idea.visualDirection} Warm, natural light, documentary feel, shallow depth of field, no faces, no text, no logos. Crop for ${format}.`,
    imageStyle: layout === "stat-led" ? "flat-colour" : "photo",
    colours: {
      background: layout === "stat-led" ? "background" : "secondary",
      text: layout === "stat-led" ? "text" : "background",
      accent: "accent",
    },
    notes: `Generated from idea ${idea.id}; ${idea.formats.includes("static") ? "idea marked static-friendly" : "idea not primarily static, treat as test"}.`,
    ...(subline ? { subline } : {}),
    ...(badge ? { badge } : {}),
  };
  if (layout === "stat-led") {
    spec.stat = { value: amount, label: truncate(tier.impact, 60) };
  }
  return spec;
}

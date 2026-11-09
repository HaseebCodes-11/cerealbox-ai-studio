import type { CampaignBrief } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import { truncate } from "../../core/text";
import type { Idea } from "../ideas/types";
import { META_TEXT_LIMITS } from "./limits";
import { CopyPackSchema, type CopyPack } from "./types";

export interface CopyGenerationInput {
  brief: CampaignBrief;
  idea: Idea;
}

const SYSTEM = `You are a senior direct-response copywriter for UK charities.
You write Meta ad copy that is specific, warm and honest. You never invent facts; every number comes from the proof points or donation tiers you are given.
You write in plain English (reading age 11-13), in the brand's voice, and you avoid the brand's banned words.
You obey the Fundraising Regulator's Code: no undue pressure, no guarantees, no misleading claims.
Respect the character limits exactly: primary text under ${META_TEXT_LIMITS.primaryText.recommended} characters for the short variant, headlines under ${META_TEXT_LIMITS.headline.recommended}, descriptions under ${META_TEXT_LIMITS.description.recommended}, story overlays under ${META_TEXT_LIMITS.storyOverlay.recommended}.
Every primary text must contain one concrete impact statement and one call to action.`;

export const copyGenerationTask = defineTask<CopyGenerationInput, CopyPack>({
  name: "copy.generate",
  description: "Turn a selected idea into a campaign-ready Meta copy pack",
  schema: CopyPackSchema,
  system: SYSTEM,
  effort: "medium",
  prompt: ({ brief, idea }) =>
    [
      `Write a Meta copy pack for ${brief.client.name}: ${brief.campaignName}.`,
      `Creative idea: "${idea.title}" (angle: ${idea.angle}). Hook: ${idea.hook}. Concept: ${idea.concept}`,
      `Audience: ${brief.audience.description}. Motivations: ${brief.audience.motivations.join("; ")}. Objections: ${brief.audience.objections.join("; ")}.`,
      `Offer: ${brief.offer.ask}. Tiers: ${brief.offer.donationTiers.map((t) => `${formatCurrency(t.amount, t.currency)} ${t.impact}`).join("; ")}.`,
      brief.offer.matchFunding ? `Match funding: ${brief.offer.matchFunding}.` : "",
      brief.offer.deadline ? `Deadline: ${brief.offer.deadline}.` : "",
      `Proof points (cite only these): ${brief.client.proofPoints.join(" | ")}`,
      `Voice: ${brief.client.voice.tone.join(", ")}. Banned words: ${brief.client.voice.avoid.join(", ") || "none"}.`,
      `Deliver: 5 hooks, 5 headlines, 3 primary texts (short/medium/long), 3 descriptions, 3 story overlays, the CTA button, and 3 messaging pillars.`,
    ]
      .filter(Boolean)
      .join("\n"),
  mock: ({ brief, idea }, { rng }) => buildMockCopy(brief, idea, rng.int(0, 1)),
});

export function buildMockCopy(brief: CampaignBrief, idea: Idea, seed = 0): CopyPack {
  const c = brief.client;
  const tiers = brief.offer.donationTiers;
  const t0 = tiers[0]!;
  const t1 = tiers[Math.min(1, tiers.length - 1)]!;
  const a0 = formatCurrency(t0.amount, t0.currency);
  const a1 = formatCurrency(t1.amount, t1.currency);
  const match = brief.offer.matchFunding;
  const deadline = brief.offer.deadline;
  const proof = c.proofPoints[seed % c.proofPoints.length] ?? c.proofPoints[0]!;
  const who = "an older person";

  const hooks = [
    truncate(idea.hook, META_TEXT_LIMITS.hook.recommended),
    `${a0} ${t0.impact}. That is the whole ask.`,
    `Right now, a cold home is a daily reality for ${who} near you.`,
    match ? `${truncate(match, 80)}.` : `${a1} ${t1.impact}.`,
    `Nobody should choose between heating and eating. You can change that today.`,
  ];

  const headlines = [
    `${a0} keeps ${who} warm`,
    `Your gift, doubled this winter`,
    `A warm home is not a luxury`,
    `${a1} ${t1.impact.split(" ").slice(0, 4).join(" ")}`,
    `Help ${who} stay warm`,
  ].map((h) => truncate(h, META_TEXT_LIMITS.headline.recommended));

  const shortText = truncate(`${a0} ${t0.impact}. ${match ? "Doubled right now. " : ""}Donate today and help ${who} stay warm.`, META_TEXT_LIMITS.primaryText.recommended);
  const mediumText = `${idea.hook} ${c.name} works in local communities so ${who} is not left choosing between heating and eating. ${a0} ${t0.impact}; ${a1} ${t1.impact}.${match ? ` ${match}.` : ""} Donate now.`;
  const longText = `${idea.hook}\n\n${proof}. This winter the need is greater than ever, and ${c.name} is ready to respond, but only with your help.\n\n${a0} ${t0.impact}. ${a1} ${t1.impact}.${match ? ` ${match}, so every gift goes twice as far.` : ""}${deadline ? ` Please give before ${deadline}.` : ""}\n\nDonate today and help ${who} feel safe at home.`;

  const descriptions = [`${a0} = a week of warmth`, `Gift Aid adds 25% at no cost`, match ? `Every gift doubled` : `Give today`].map((d) => truncate(d, META_TEXT_LIMITS.description.recommended));

  const storyOverlays = [
    truncate(`${a0} ${t0.impact}`, META_TEXT_LIMITS.storyOverlay.recommended),
    truncate(match ? `Your gift doubled until ${deadline ?? "the deadline"}` : `Help ${who} stay warm this winter`, META_TEXT_LIMITS.storyOverlay.recommended),
    truncate(`Swipe up to donate ${a0}`, META_TEXT_LIMITS.storyOverlay.recommended),
  ];

  return {
    hooks,
    headlines,
    primaryTexts: [
      { variant: "short", text: shortText, angle: idea.angle },
      { variant: "medium", text: mediumText, angle: idea.angle },
      { variant: "long", text: longText, angle: idea.angle },
    ],
    descriptions,
    storyOverlays,
    ctaButton: brief.objective === "donations" || brief.objective === "regular_giving" ? "DONATE_NOW" : brief.objective === "leads" ? "SIGN_UP" : "LEARN_MORE",
    messagingPillars: [
      `Concrete impact: ${a0} ${t0.impact}`,
      match ? `Urgency: ${match}` : `Urgency: winter is here now`,
      `Trust: ${proof}`,
    ],
  };
}

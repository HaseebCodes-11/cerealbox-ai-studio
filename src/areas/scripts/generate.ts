import type { CampaignBrief } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import { spokenSeconds, truncate } from "../../core/text";

import type { CopyPack } from "../copy/types";
import type { Idea } from "../ideas/types";
import { ScriptBatchSchema, type Beat, type Script, type ScriptBatch, type ScriptStyle } from "./types";

export interface ScriptGenerationInput {
  brief: CampaignBrief;
  idea: Idea;
  copy: CopyPack;
  requests: Array<{ style: ScriptStyle; targetSeconds: 15 | 30 | 60 }>;
}

const SYSTEM = `You write short-form video scripts for charity paid social (Reels, Stories, TikTok-style).
Structure every script as beats: hook, problem, turn, proof, offer, cta. The hook must land in the first 2-3 seconds and be under 12 words.
Write voiceover as natural speech at about 150 words per minute, and make the beat durations add up to the target length.
Give each beat a concrete visual, on-screen text (under 80 characters) and b-roll keywords.
Only cite numbers from the proof points or donation tiers. Avoid the brand's banned words and any guilt-trip or pressure language.
UGC-style scripts are written in first person, conversational, with small imperfections. Founder scripts are plain and accountable.`;

export const scriptGenerationTask = defineTask<ScriptGenerationInput, ScriptBatch>({
  name: "scripts.generate",
  description: "Write short-form ad scripts in requested styles and lengths",
  schema: ScriptBatchSchema,
  system: SYSTEM,
  effort: "medium",
  prompt: ({ brief, idea, copy, requests }) =>
    [
      `Client: ${brief.client.name} (${brief.client.cause}). Campaign: ${brief.campaignName}.`,
      `Idea: ${idea.title} (${idea.angle}). Hook: ${idea.hook}. Concept: ${idea.concept}`,
      `Audience: ${brief.audience.description}. Objections: ${brief.audience.objections.join("; ")}.`,
      `Offer: ${brief.offer.donationTiers.map((t) => `${formatCurrency(t.amount, t.currency)} ${t.impact}`).join("; ")}.${brief.offer.matchFunding ? ` ${brief.offer.matchFunding}.` : ""}`,
      `Proof points: ${brief.client.proofPoints.join(" | ")}`,
      `Approved messaging pillars: ${copy.messagingPillars.join(" | ")}`,
      `Banned words: ${brief.client.voice.avoid.join(", ") || "none"}.`,
      `Scripts to write: ${requests.map((r) => `${r.style} at ${r.targetSeconds}s`).join("; ")}.`,
    ].join("\n"),
  mock: ({ brief, idea, requests }) => ({
    scripts: requests.map((r, i) => buildMockScript(brief, idea, r.style, r.targetSeconds, i)),
  }),
});

/** Beat time allocation as a share of the total, per target length. */
export const BEAT_SHARES: Record<15 | 30 | 60, Record<Beat["name"], number>> = {
  15: { hook: 0.2, problem: 0.2, turn: 0.15, proof: 0.15, offer: 0.15, cta: 0.15 },
  30: { hook: 0.12, problem: 0.2, turn: 0.15, proof: 0.2, offer: 0.18, cta: 0.15 },
  60: { hook: 0.06, problem: 0.24, turn: 0.15, proof: 0.25, offer: 0.18, cta: 0.12 },
};

type Size = "short" | "medium" | "long";

/**
 * Deterministic script copy per beat, written at three lengths so the word
 * count fits the target duration without mid-sentence truncation.
 */
function beatLines(brief: CampaignBrief, idea: Idea, style: ScriptStyle, size: Size): Record<Beat["name"], { vo: string; text: string; visual: string; broll: string[] }> {
  const c = brief.client;
  const tier = brief.offer.donationTiers[0]!;
  const amount = formatCurrency(tier.amount, tier.currency);
  const proof = c.proofPoints[0]!;
  const match = brief.offer.matchFunding;
  const firstPerson = style === "ugc-testimonial" || style === "founder-direct";
  const founder = style === "founder-direct";

  // Hooks must land in ~3 seconds: use the idea's hook only if it is short enough.
  const ideaHookWords = idea.hook.trim().split(/\s+/).length;
  const firstSentence = idea.hook.split(/(?<=[.!?])\s+/)[0] ?? idea.hook;
  const compactHook = ideaHookWords <= 12 ? idea.hook : firstSentence.split(/\s+/).length <= 12 ? firstSentence : `Here is what ${amount} does this winter.`;

  const hookVo = {
    short: founder ? `I run ${c.name}. Here's where your money goes.` : firstPerson ? `Checked your mum's heating lately?` : ideaHookWords <= 8 ? idea.hook : `What does ${amount} do this winter?`,
    medium: founder ? `I run ${c.name}. I want to tell you exactly where ${amount} goes.` : firstPerson ? `Honest question. When did you last check how warm your mum's house is?` : compactHook,
    long: founder ? `I run ${c.name}. I want to tell you exactly where ${amount} goes this winter.` : firstPerson ? `Honest question. When did you last check how warm your mum's house actually is?` : compactHook,
  }[size];

  const problemVo = {
    short: firstPerson && !founder ? `My nan heated one room last winter and told nobody.` : `Older people heat one room and tell nobody.`,
    medium: firstPerson ? `My nan heated one room last winter and told nobody. ${c.name} says that's common.` : `Across the UK, older people heat one room and skip meals to pay the bill. Most never tell their family.`,
    long: firstPerson
      ? `My nan heated one room last winter and told nobody. She put on a second coat indoors and said she was fine. ${c.name} told me that is one of the most common things they see, and families usually find out last.`
      : `Across the UK, older people are heating one room, going to bed early to save on the bill, and telling nobody. Families usually find out last, and by then the cold has already done its damage to health and confidence.`,
  }[size];

  const turnVo = {
    short: `${amount} changes that.`,
    medium: firstPerson ? `Then I found out what ${amount} actually does.` : `It does not take much to change that.`,
    long: firstPerson ? `Then I found out what ${amount} actually does, and it honestly surprised me.` : `It does not take much to change that, and the fix is more practical than people expect.`,
  }[size];

  const proofVo = {
    short: `${proof}.`,
    medium: `${proof}. They've been doing this since 2009.`,
    long: `${proof}. The team has worked in local communities since 2009, visiting homes, fixing boilers and sorting insulation, so the money turns into warmth within days, not months.`,
  }[size];

  const offerVo = {
    short: `${amount} ${tier.impact}.`,
    medium: `${amount} ${tier.impact}.${match ? " And right now, every gift is doubled." : ""}`,
    long: `${amount} ${tier.impact}.${match ? ` And right now, ${match.toLowerCase()}, so your ${amount} becomes ${formatCurrency(tier.amount * 2, tier.currency)} of heating.` : ""} It is a small amount with a very direct result.`,
  }[size];

  const ctaVo = {
    short: `Donate ${amount} today.`,
    medium: firstPerson ? `Tap the link, give ${amount}, and someone's heating goes on this week.` : `Donate ${amount} today and help someone stay warm this winter.`,
    long: firstPerson ? `Tap the link, give ${amount}, and someone's heating goes on this week. It took me two minutes.` : `Donate ${amount} today and help an older person stay warm this winter. Two minutes, and the heating goes on.`,
  }[size];

  return {
    hook: {
      vo: hookVo,
      text: truncate(idea.hook, 60),
      visual: firstPerson ? "Presenter to camera, phone held at eye level, kitchen background" : "Fast cut: cold kitchen, breath visible, kettle not on",
      broll: ["kettle", "kitchen", "frost on window"],
    },
    problem: {
      vo: problemVo,
      text: "Heating one room. Telling no one.",
      visual: "Slow push on a single lit window in a dark terrace",
      broll: ["terrace street at dusk", "one lit window", "radiator"],
    },
    turn: {
      vo: turnVo,
      text: `${amount} changes that`,
      visual: "Hard cut to warm light; hands wrap around a mug",
      broll: ["hands around mug", "warm light", "radiator warming"],
    },
    proof: {
      vo: proofVo,
      text: truncate(proof, 70),
      visual: "Documentary footage of the home visit team with captions",
      broll: ["home visit", "team in branded jackets", "insulation kit"],
    },
    offer: {
      vo: offerVo,
      text: truncate(`${amount} ${tier.impact}${match ? " · Doubled" : ""}`, 70),
      visual: "Tier card animates in over warm footage",
      broll: ["heating dial", "thermostat"],
    },
    cta: {
      vo: ctaVo,
      text: `Donate ${amount} today`,
      visual: "End card: logo, CTA, donation URL",
      broll: ["end card"],
    },
  };
}

export function buildMockScript(brief: CampaignBrief, idea: Idea, style: ScriptStyle, targetSeconds: 15 | 30 | 60, index: number): Script {
  const size: Size = targetSeconds === 15 ? "short" : targetSeconds === 30 ? "medium" : "long";
  const lines = beatLines(brief, idea, style, size);
  const shares = BEAT_SHARES[targetSeconds];
  const firstPerson = style === "ugc-testimonial" || style === "founder-direct";

  const beats: Beat[] = (Object.keys(shares) as Beat["name"][]).map((name) => {
    const l = lines[name];
    return {
      name,
      voiceover: l.vo,
      onScreenText: l.text,
      visual: l.visual,
      brollKeywords: l.broll,
      seconds: Math.round(shares[name] * targetSeconds * 10) / 10,
    };
  });

  const estimated = Math.round(beats.reduce((s, b) => s + Math.max(b.seconds, spokenSeconds(b.voiceover)), 0) * 10) / 10;

  return {
    id: `script-${idea.id}-${style}-${targetSeconds}s-${index}`,
    ideaId: idea.id,
    title: `${idea.title} (${style}, ${targetSeconds}s)`,
    style,
    targetSeconds,
    aspect: "9:16",
    beats,
    captionStyle: "burned-in-bold",
    musicMood: firstPerson ? "none or very low acoustic bed" : "warm, understated piano",
    disclosureRequired: style === "ugc-testimonial",
    estimatedSeconds: estimated,
  };
}

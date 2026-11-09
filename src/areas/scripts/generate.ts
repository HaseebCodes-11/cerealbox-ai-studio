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
      `Creative context: problem day to day: "${brief.creativeContext.problemInDailyLife}" · supporter line: "${brief.creativeContext.storySeed}" · opening question: "${brief.creativeContext.openingQuestion}" · setting: ${brief.creativeContext.settingNoun} · footage available: ${brief.creativeContext.brollKeywords.join(", ")}.`,
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

/** Pick b-roll keywords for a beat from the brief's footage list, spreading them across beats. */
function brollFor(keywords: string[], beatIndex: number, per = 3): string[] {
  if (keywords.length === 0) return [];
  const start = (beatIndex * per) % keywords.length;
  const out: string[] = [];
  for (let i = 0; i < per; i++) out.push(keywords[(start + i) % keywords.length]!);
  return [...new Set(out)];
}

/**
 * Deterministic script copy per beat, written at three lengths from the
 * brief's creative context so the word count fits the target duration.
 */
function beatLines(brief: CampaignBrief, idea: Idea, style: ScriptStyle, size: Size): Record<Beat["name"], { vo: string; text: string; visual: string; broll: string[] }> {
  const c = brief.client;
  const cc = brief.creativeContext;
  const tier = brief.offer.donationTiers[0]!;
  const amount = formatCurrency(tier.amount, tier.currency);
  const proof = c.proofPoints[0]!;
  const proof2 = c.proofPoints[c.proofPoints.length - 1] ?? proof;
  const match = brief.offer.matchFunding;
  const firstPerson = style === "ugc-testimonial" || style === "founder-direct";
  const founder = style === "founder-direct";
  const who = cc.beneficiarySingular;
  const whoPlural = cc.beneficiaryPlural;
  const kw = cc.brollKeywords;

  const ideaHookWords = idea.hook.trim().split(/\s+/).length;
  const firstSentence = idea.hook.split(/(?<=[.!?])\s+/)[0] ?? idea.hook;
  const compactHook = ideaHookWords <= 12 ? idea.hook : firstSentence.split(/\s+/).length <= 12 ? firstSentence : `Here is what ${amount} does right now.`;

  // Short cuts need very tight lines: first clause of the problem, shortest proof point that is not a tier line.
  const problemShort = cc.problemInDailyLife.split(/,|;/)[0]!.replace(/[.!?]*$/, ".");
  const tierImpacts = new Set(brief.offer.donationTiers.map((t) => t.impact.toLowerCase()));
  const proofShort = [...c.proofPoints]
    .filter((p) => !tierImpacts.has(p.replace(/^£\d+\s+/, "").toLowerCase()))
    .sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length)[0] ?? proof;

  const hookVo = {
    short: founder ? `I run ${c.name}. Here's where ${amount} goes.` : firstPerson ? `Quick one about ${whoPlural} near you.` : ideaHookWords <= 8 ? idea.hook : `What does ${amount} actually do?`,
    medium: founder ? `I run ${c.name}. I want to tell you exactly where ${amount} goes.` : firstPerson ? `Honest question. ${cc.openingQuestion}` : compactHook,
    long: founder ? `I run ${c.name}. I want to tell you exactly where ${amount} goes.` : firstPerson ? `Honest question. ${cc.openingQuestion}` : compactHook,
  }[size];

  const problemVo = {
    short: problemShort,
    medium: firstPerson && !founder ? `${cc.storySeed} ${c.name} says that's common.` : `${cc.problemInDailyLife} Most never tell anyone.`,
    long: firstPerson && !founder
      ? `${cc.storySeed} ${c.name} told me that is one of the most common things they see, and the people closest usually find out last.`
      : `${cc.problemInDailyLife} The people closest to them usually find out last, and by then the damage to health and confidence is already done.`,
  }[size];

  const turnVo = {
    short: `${amount} changes that.`,
    medium: firstPerson ? `Then I found out what ${amount} actually does.` : `It does not take much to change that.`,
    long: firstPerson ? `Then I found out what ${amount} actually does, and it honestly surprised me.` : `It does not take much to change that, and the fix is more practical than people expect.`,
  }[size];

  const proofVo = {
    short: `${proofShort}.`,
    medium: `${proof}.`,
    long: `${proof}. ${proof2}. The team ${cc.whatWeDo} So the money turns into help within days, not months.`,
  }[size];

  const offerVo = {
    short: `${amount} ${tier.impact}.`,
    medium: `${amount} ${tier.impact}.${match ? " And right now, every gift is doubled." : ""}`,
    long: `${amount} ${tier.impact}.${match ? ` And right now, ${match.toLowerCase()}, so your ${amount} becomes ${formatCurrency(tier.amount * 2, tier.currency)}.` : ""} It is a small amount with a very direct result.`,
  }[size];

  const ctaVo = {
    short: `Donate ${amount} today.`,
    medium: firstPerson ? `Tap the link, give ${amount}, and ${who} gets help this week.` : `Donate ${amount} today and help ${who}.`,
    long: firstPerson ? `Tap the link, give ${amount}, and ${who} gets help this week. It took me two minutes.` : `Donate ${amount} today and help ${who}. Two minutes, and it is done.`,
  }[size];

  return {
    hook: {
      vo: hookVo,
      text: truncate(idea.hook, 60),
      visual: firstPerson ? `Presenter to camera, phone held at eye level, ${cc.settingNoun} background` : `Fast cut: a ${cc.settingNoun} that shows the problem, no people`,
      broll: brollFor(kw, 0),
    },
    problem: {
      vo: problemVo,
      text: truncate(cc.problemInDailyLife, 80),
      visual: `Slow push on a quiet ${cc.settingNoun}, natural light`,
      broll: brollFor(kw, 1),
    },
    turn: {
      vo: turnVo,
      text: `${amount} changes that`,
      visual: "Hard cut to warm light; the thing the gift buys enters frame",
      broll: brollFor(kw, 2),
    },
    proof: {
      vo: proofVo,
      text: truncate(proof, 70),
      visual: `Documentary footage of the ${c.name} team with captions`,
      broll: brollFor(kw, 3),
    },
    offer: {
      vo: offerVo,
      text: truncate(`${amount} ${tier.impact}${match ? " · Doubled" : ""}`, 70),
      visual: "Tier card animates in over warm footage",
      broll: brollFor(kw, 4),
    },
    cta: {
      vo: ctaVo,
      text: `Donate ${amount} today`,
      visual: "End card: logo, CTA, donation URL",
      broll: ["end card"],
    },
  };
}

export const SCRIPT_DURATIONS = [15, 30, 60] as const;

export function buildMockScript(brief: CampaignBrief, idea: Idea, style: ScriptStyle, targetSeconds: 15 | 30 | 60, index: number): Script {
  if (!(SCRIPT_DURATIONS as readonly number[]).includes(targetSeconds)) {
    throw new Error(`Unsupported script duration ${String(targetSeconds)}s; use 15, 30 or 60.`);
  }
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

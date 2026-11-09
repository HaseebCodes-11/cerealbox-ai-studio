import type { CampaignBrief } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import { truncate } from "../../core/text";
import { IDEA_ANGLES, IdeaBatchSchema, type Idea, type IdeaAngle, type IdeaBatch } from "./types";

export interface IdeaGenerationInput {
  brief: CampaignBrief;
  count: number;
  /** Titles/hooks of ideas already used for this client so the model avoids them. */
  previousIdeas: string[];
  /** Angles to exclude (e.g. the three already tested this quarter). */
  excludeAngles: IdeaAngle[];
}

const SYSTEM = `You are the creative director of a UK performance agency that works only with charities.
You generate campaign ideas that are specific, surprising and buildable, never generic.
Rules:
- Each idea must use a different named angle from the list provided.
- Ground every idea in the brief: the audience's real motivations and objections, the offer, the proof points, the creative context.
- Never invent statistics. Only use numbers that appear in the proof points or donation tiers.
- Avoid the brand's banned words.
- Respect UK fundraising regulation: no undue pressure, no guilt-trip framing, no guarantees.
- Each idea must say which formats it suits (static, video, ugc, landing) and give a concrete visual direction.
- Score yourself honestly on novelty, clarity, emotional pull, brand fit and feasibility (0-10).`;

export const ideaGenerationTask = defineTask<IdeaGenerationInput, IdeaBatch>({
  name: "ideas.generate",
  description: "Generate a batch of distinct campaign ideas from a brief",
  schema: IdeaBatchSchema,
  system: SYSTEM,
  effort: "high",
  prompt: (input) => {
    const { brief } = input;
    const cc = brief.creativeContext;
    const angles = IDEA_ANGLES.filter((a) => !input.excludeAngles.includes(a));
    return [
      `Generate ${input.count} campaign ideas for ${brief.client.name} (${brief.client.cause}).`,
      `Campaign: ${brief.campaignName}. Objective: ${brief.objective}.`,
      `Key message: ${brief.keyMessage}`,
      `Audience: ${brief.audience.name} - ${brief.audience.description}.`,
      `Motivations: ${brief.audience.motivations.join("; ")}.`,
      `Objections to overcome: ${brief.audience.objections.join("; ")}.`,
      `Offer: ${brief.offer.ask}. Tiers: ${brief.offer.donationTiers.map((t) => `${formatCurrency(t.amount, t.currency)} ${t.impact}`).join("; ")}.`,
      brief.offer.matchFunding ? `Match funding: ${brief.offer.matchFunding}.` : "",
      brief.offer.deadline ? `Deadline: ${brief.offer.deadline}.` : "",
      `Proof points you may cite verbatim: ${brief.client.proofPoints.join(" | ")}`,
      `Creative context: the problem day to day: "${cc.problemInDailyLife}" · a supporter might say: "${cc.storySeed}" · the audience is already asking: "${cc.openingQuestion}" · everyday comparison for ${formatCurrency(brief.offer.donationTiers[0]!.amount)}: ${cc.everydayComparison} · setting: ${cc.settingNoun}.`,
      `Brand voice: ${brief.client.voice.tone.join(", ")}. Never use: ${brief.client.voice.avoid.join(", ") || "n/a"}.`,
      `Available angles: ${angles.join(", ")}.`,
      input.previousIdeas.length ? `Do not repeat these previous ideas: ${input.previousIdeas.join(" | ")}` : "",
      brief.references.length ? `Learnings from past campaigns: ${brief.references.join(" | ")}` : "",
      `Return exactly ${input.count} ideas, each with a unique angle.`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  mock: (input, { rng }) => {
    const { brief } = input;
    const angles = rng.shuffle(IDEA_ANGLES.filter((a) => !input.excludeAngles.includes(a)));
    const ideas: Idea[] = [];
    for (let i = 0; i < input.count; i++) {
      const angle = angles[i % angles.length] as IdeaAngle;
      ideas.push(buildMockIdea(brief, angle, i, rng.int(0, 2)));
    }
    return { ideas };
  },
});

/**
 * Deterministic idea templates per angle, built from the brief's creative
 * context so they read right for any cause. They exist so the demo and tests
 * work offline; with LLM_PROVIDER=anthropic the model writes these itself.
 */
export function buildMockIdea(brief: CampaignBrief, angle: IdeaAngle, index: number, variantSeed = 0): Idea {
  const c = brief.client;
  const cc = brief.creativeContext;
  const tier = brief.offer.donationTiers[Math.min(variantSeed, brief.offer.donationTiers.length - 1)] ?? brief.offer.donationTiers[0]!;
  const amount = formatCurrency(tier.amount, tier.currency);
  const motivation = brief.audience.motivations[variantSeed % brief.audience.motivations.length] ?? brief.audience.motivations[0]!;
  const objection = brief.audience.objections[variantSeed % Math.max(1, brief.audience.objections.length)] ?? "it won't make a difference";
  const proof = c.proofPoints[variantSeed % c.proofPoints.length] ?? c.proofPoints[0]!;
  const who = cc.beneficiarySingular;
  const whoPlural = cc.beneficiaryPlural;
  const setting = cc.settingNoun;
  const id = `idea-${index + 1}-${angle}`;
  const base = { id, riskFlags: [] as string[] };
  const hook = (text: string) => truncate(text, 160);

  switch (angle) {
    case "contrast":
      return {
        ...base,
        title: truncate(`Two ${setting}s, one difference`, 80),
        angle,
        hook: hook(`Same street. Same week. One ${setting} has what it needs. One doesn't.`),
        concept: `A split-frame creative showing two near-identical ${setting}s: one with what it needs, one without. The only difference is a ${amount} gift. Copy explains that ${amount} ${tier.impact}.`,
        whyItWorks: `Contrast makes an invisible problem visible in under two seconds, and the ${amount} price tag answers "what does my money actually do".`,
        audienceInsight: motivation,
        formats: ["static", "video", "landing"],
        visualDirection: `Split screen of two ${setting}s, warm vs cold colour grade, one line of copy across the seam, logo bottom right.`,
        scores: { novelty: 7, clarity: 9, emotionalPull: 8, brandFit: 9, feasibility: 9 },
      };
    case "stat-led":
      return {
        ...base,
        title: "The number behind the ask",
        angle,
        hook: hook(`${amount}. That is what it takes: ${tier.impact}.`),
        concept: `A single oversized number fills the frame with a short line underneath: "${tier.impact}". Supporting line cites: ${proof}.`,
        whyItWorks: "A specific, small number removes the 'drop in the ocean' feeling and makes the ask feel finishable.",
        audienceInsight: motivation,
        formats: ["static", "landing"],
        visualDirection: `Flat brand background, huge numeral in accent colour, a tight crop of the ${setting} in the lower third.`,
        scores: { novelty: 6, clarity: 10, emotionalPull: 7, brandFit: 9, feasibility: 10 },
      };
    case "testimonial":
      return {
        ...base,
        title: "In their own words",
        angle,
        hook: hook(`"${cc.storySeed}" A supporter on why they give.`),
        concept: `A short first-person line from a supporter or someone ${c.name} helped, read aloud or shown as text over a quiet ${setting} scene. Ends with: ${proof}.`,
        whyItWorks: "First-person language signals authenticity and sidesteps charity cliches.",
        audienceInsight: motivation,
        formats: ["ugc", "video", "static"],
        visualDirection: `Natural light, slow push-in on a ${setting}, quote as large serif text, consent-cleared contributor or voice actor.`,
        riskFlags: ["Requires written consent from the contributor; use a voice actor if not available"],
        scores: { novelty: 6, clarity: 8, emotionalPull: 9, brandFit: 9, feasibility: 7 },
      };
    case "myth-bust":
      return {
        ...base,
        title: truncate(`Myth: ${objection.replace(/^(worried|assumes|thinks) (that )?/i, "")}`, 80),
        angle,
        hook: hook(`"${objection.replace(/^(worried|assumes|thinks) (that )?/i, "")}." Here is what actually happens.`),
        concept: `Directly tackles the objection "${objection}" in the first line, then explains the gap ${c.name} fills and what ${amount} does about it.`,
        whyItWorks: "Naming the objection first earns trust and pre-empts the scroll-past.",
        audienceInsight: objection,
        formats: ["video", "ugc", "static"],
        visualDirection: "Text-first creative: objection struck through, answer beneath, presenter to camera for video.",
        scores: { novelty: 8, clarity: 9, emotionalPull: 6, brandFit: 8, feasibility: 9 },
      };
    case "behind-the-scenes":
      return {
        ...base,
        title: `Ride along with the ${c.name} team`,
        angle,
        hook: hook(`We filmed one Tuesday with the ${c.name} team. This is what ${amount} looks like in real life.`),
        concept: `Documentary-style footage of the team doing the work the donation funds (${tier.impact}). No actors, no music swells, just the work.`,
        whyItWorks: "Showing the operation answers the admin-cost worry better than any pie chart.",
        audienceInsight: objection,
        formats: ["video", "ugc"],
        visualDirection: "Handheld, natural sound, captions throughout, team in branded jackets, end card with the tier.",
        scores: { novelty: 7, clarity: 8, emotionalPull: 8, brandFit: 10, feasibility: 6 },
      };
    case "urgency-match":
      return {
        ...base,
        title: "Doubled until the deadline",
        angle,
        hook: hook(brief.offer.matchFunding ? `${brief.offer.matchFunding}.` : `Give before ${brief.offer.deadline ?? "the deadline"} and your gift goes further.`),
        concept: `A countdown-led creative built around the match offer. ${amount} becomes ${formatCurrency(tier.amount * 2, tier.currency)} and the copy states exactly what that pays for twice over.`,
        whyItWorks: "Match funding is the strongest proven conversion lever in charity paid social; the deadline gives a reason to act today rather than someday.",
        audienceInsight: motivation,
        formats: ["static", "video", "landing"],
        visualDirection: "Bold accent background, the two amounts side by side with an arrow, deadline date in a sticker element.",
        riskFlags: brief.offer.matchFunding ? [] : ["No match funding in brief; confirm the offer before use"],
        scores: { novelty: 5, clarity: 10, emotionalPull: 7, brandFit: 8, feasibility: 10 },
      };
    case "founder-direct":
      return {
        ...base,
        title: "Thirty seconds from our director",
        angle,
        hook: hook(`I run ${c.name}. I want to tell you exactly where your ${amount} goes.`),
        concept: `A single unedited take of the charity director speaking plainly about the weeks ahead and the offer. No b-roll, captions only.`,
        whyItWorks: "Low production, high trust. Direct accountability answers the admin objection head on.",
        audienceInsight: objection,
        formats: ["video", "ugc"],
        visualDirection: "Phone camera, eye level, office or depot background, burned-in captions, 9:16.",
        scores: { novelty: 6, clarity: 9, emotionalPull: 7, brandFit: 9, feasibility: 10 },
      };
    case "how-it-works":
      return {
        ...base,
        title: truncate(`From your gift to ${who}`, 80),
        angle,
        hook: hook(`What happens in the 48 hours after you give ${amount}?`),
        concept: `A three-step explainer: you give, we act, ${who} gets what they need. Each step shows the real person or system involved, ending with "${tier.impact}".`,
        whyItWorks: "Transparency about process is a direct response to the fear that money disappears into admin.",
        audienceInsight: objection,
        formats: ["video", "static", "landing"],
        visualDirection: "Three-panel carousel or 15s animation with simple icons in brand colours, one sentence per panel.",
        scores: { novelty: 7, clarity: 9, emotionalPull: 6, brandFit: 9, feasibility: 9 },
      };
    case "local-pride":
      return {
        ...base,
        title: truncate(`${capitalise(whoPlural)} in your postcode`, 80),
        angle,
        hook: hook(`Within two miles of you: ${lowerFirst(cc.problemInDailyLife)}`),
        concept: `Geo-personalised copy by region, with ${c.name}'s local track record (${proof}). The ask stays national; the framing feels like a neighbour.`,
        whyItWorks: "Proximity increases perceived responsibility and makes impact feel checkable.",
        audienceInsight: motivation,
        formats: ["static", "landing"],
        visualDirection: `Map-pin style graphic over a local street at dusk, one ${setting} highlighted in accent colour.`,
        riskFlags: ["Needs region-level ad set split for the personalised line"],
        scores: { novelty: 7, clarity: 8, emotionalPull: 7, brandFit: 8, feasibility: 7 },
      };
    case "unexpected-comparison":
      return {
        ...base,
        title: truncate(`Less than ${cc.everydayComparison}`, 80),
        angle,
        hook: hook(`${amount} is ${cc.everydayComparison}. Or it ${tier.impact}.`),
        concept: `Pairs the tier with an everyday spend the audience makes without thinking (${cc.everydayComparison}), making the gift feel affordable and the impact feel outsized.`,
        whyItWorks: "Anchoring against a familiar price reframes the decision from charity to value.",
        audienceInsight: motivation,
        formats: ["static", "video"],
        visualDirection: `Two objects on a plain surface: ${cc.everydayComparison} and the thing the gift buys, equals sign between them.`,
        scores: { novelty: 7, clarity: 9, emotionalPull: 6, brandFit: 7, feasibility: 10 },
      };
    case "letter":
      return {
        ...base,
        title: "A letter you will not get",
        angle,
        hook: hook(`Most people we help never write to thank anyone. This is the letter they would send.`),
        concept: `A handwritten-style letter from ${who} describing an ordinary good day, revealed line by line. Signed with a first name only. Closes with the ${amount} ask.`,
        whyItWorks: "The letter form slows the reader down and rewards attention with emotion rather than shock.",
        audienceInsight: motivation,
        formats: ["video", "static", "landing"],
        visualDirection: "Paper texture, handwriting font animated as if being written, soft lamp light.",
        riskFlags: ["Must be clearly labelled as representative, not a real letter, unless consent exists"],
        scores: { novelty: 8, clarity: 7, emotionalPull: 9, brandFit: 8, feasibility: 8 },
      };
    case "question":
      return {
        ...base,
        title: truncate(cc.openingQuestion.replace(/\?$/, ""), 80),
        angle,
        hook: hook(cc.openingQuestion),
        concept: `Opens with a question the audience is already half-asking, then widens it to ${c.cause.toLowerCase()} and the ${amount} ask.`,
        whyItWorks: "A personal question earns the first second of attention without shock imagery.",
        audienceInsight: motivation,
        formats: ["ugc", "video", "static"],
        visualDirection: `Presenter to camera for UGC; for static, the question in large type over a ${setting} scene.`,
        scores: { novelty: 7, clarity: 9, emotionalPull: 8, brandFit: 9, feasibility: 9 },
      };
    default: {
      const exhaustive: never = angle;
      throw new Error(`Unhandled angle ${String(exhaustive)}`);
    }
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

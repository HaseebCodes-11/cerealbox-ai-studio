import type { CampaignBrief } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import { slugify, truncate } from "../../core/text";
import type { CopyPack } from "../copy/types";
import type { Idea } from "../ideas/types";
import { LandingPageSpecSchema, type LandingPageSpec } from "./types";

export interface LandingSpecInput {
  brief: CampaignBrief;
  idea: Idea;
  copy: CopyPack;
  variant: "A" | "B";
}

const SYSTEM = `You design high-converting fundraising landing pages for UK charities.
You produce a page specification: title and meta description (SEO limits), a hero with one clear ask, the problem in plain terms, impact tiers that match the donation amounts exactly, proof points taken verbatim from the brief, a short story, FAQs that answer the audience's real objections, trust signals, the donation form, and a closing CTA.
Rules: one message per page; headline under 80 characters; every number from the brief; Gift Aid must be offered to UK donors; no pressure or guilt language; plain English at reading age 11-13.
Variant B must differ from A in exactly one meaningful way (usually the headline framing) and state the hypothesis being tested.`;

export const landingSpecTask = defineTask<LandingSpecInput, LandingPageSpec>({
  name: "landing.spec",
  description: "Produce a landing page spec from brief, idea and copy",
  schema: LandingPageSpecSchema,
  system: SYSTEM,
  effort: "medium",
  prompt: ({ brief, idea, copy, variant }) =>
    [
      `Client: ${brief.client.name} (${brief.client.cause}). Website: ${brief.client.website}. Charity number: ${brief.client.charityNumber ?? "n/a"}.`,
      `Campaign: ${brief.campaignName}. Idea: ${idea.title} (${idea.angle}): ${idea.concept}`,
      `Approved headlines: ${copy.headlines.join(" | ")}. Messaging pillars: ${copy.messagingPillars.join(" | ")}.`,
      `Offer: ${brief.offer.ask}. Tiers: ${brief.offer.donationTiers.map((t) => `${formatCurrency(t.amount, t.currency)} ${t.impact}`).join("; ")}.${brief.offer.matchFunding ? ` Match: ${brief.offer.matchFunding}.` : ""}`,
      `Proof points: ${brief.client.proofPoints.join(" | ")}`,
      `Audience objections to answer in the FAQ: ${brief.audience.objections.join("; ")}`,
      `Compliance notes: ${brief.client.complianceNotes.join("; ") || "none"}`,
      `Gift Aid eligible: ${brief.offer.giftAidEligible ? "yes" : "no"}.`,
      `Variant: ${variant}.`,
    ].join("\n"),
  mock: ({ brief, idea, copy, variant }) => buildMockLandingSpec(brief, idea, copy, variant),
});

export function buildMockLandingSpec(brief: CampaignBrief, idea: Idea, copy: CopyPack, variant: "A" | "B"): LandingPageSpec {
  const c = brief.client;
  const tiers = brief.offer.donationTiers;
  const t0 = tiers[0]!;
  const a0 = formatCurrency(t0.amount, t0.currency);
  const match = brief.offer.matchFunding;
  const headlineA = copy.headlines[0] ?? idea.title;
  const headlineB = match ? `Your gift goes twice as far this winter` : (copy.headlines[1] ?? idea.hook);
  const headline = truncate(variant === "A" ? headlineA : headlineB, 80);

  const faq = brief.audience.objections.slice(0, 5).map((objection) => ({
    question: truncate(objectionToQuestion(objection), 120),
    answer: truncate(objectionToAnswer(objection, c.name, c.proofPoints), 400),
  }));
  if (faq.length < 2) {
    faq.push({ question: "Is my donation secure?", answer: `Yes. Payments are processed by our regulated payment provider and ${c.name} never stores your card details.` });
  }

  return {
    id: `landing-${idea.id}-${variant}`,
    ideaId: idea.id,
    variant,
    variantHypothesis: variant === "A" ? "Control: impact-led headline from the approved copy pack." : "Test: urgency/match-led headline lifts conversion rate without lowering average gift.",
    slug: slugify(`${brief.campaignName}-${variant}`),
    title: truncate(`${brief.offer.ask} | ${c.name}`, 60),
    metaDescription: truncate(`${a0} ${t0.impact}. ${match ? `${match}. ` : ""}Donate to ${c.name} today and help an older person stay warm this winter.`, 155).padEnd(50, " ").trim(),
    hero: {
      headline,
      subheadline: truncate(`${a0} ${t0.impact}.${match ? ` ${match}.` : ""} Give in two minutes.`, 180),
      ctaLabel: `Donate ${a0}`,
      imagePrompt: `${idea.visualDirection} Warm natural light, documentary feel, no identifiable faces, space on the left for text.`,
      imageAlt: truncate(`Warm kitchen scene representing ${c.name}'s work`, 125),
    },
    problem: {
      heading: "The problem, plainly",
      body: `${brief.keyMessage} Across the UK, older people are heating one room, going to bed early to stay warm and telling nobody. ${c.name} finds them, fixes the immediate problem and helps them claim the support they are entitled to.`,
    },
    impact: tiers.map((t) => ({ amount: t.amount, label: truncate(capitalise(t.impact), 90) })),
    proof: c.proofPoints.slice(0, 4).map((text) => ({ text: truncate(text, 160) })),
    story: {
      heading: "What a warm home changes",
      body: `Last winter a retired postman in Leeds was heating his kitchen with the oven door open. A ${c.name} home visit fixed his boiler timer, fitted draught excluders and sorted a grant he did not know existed. He told the team he had stopped dreading the postman. Names and details changed to protect privacy; the case is real.`,
      attribution: `${c.name} home visit team`,
    },
    faq,
    trust: [
      c.charityNumber ? `Registered charity no. ${c.charityNumber}` : `Registered charity`,
      "Registered with the Fundraising Regulator",
      "Secure payments",
      brief.offer.giftAidEligible ? "Gift Aid adds 25% at no cost to you" : "Every gift makes a difference",
    ],
    form: {
      amounts: tiers.map((t) => t.amount),
      defaultAmount: tiers[Math.min(1, tiers.length - 1)]!.amount,
      frequencies: brief.objective === "regular_giving" ? ["monthly", "one-off"] : ["one-off", "monthly"],
      giftAid: brief.offer.giftAidEligible,
      currency: t0.currency,
      buttonLabel: "Donate now",
    },
    closingCta: {
      headline: truncate(match ? `Give before ${brief.offer.deadline ?? "the deadline"} and your gift is doubled` : `Help an older person stay warm this winter`, 90),
      ctaLabel: `Donate ${a0}`,
    },
  };
}

function objectionToQuestion(objection: string): string {
  const o = objection.toLowerCase();
  if (o.includes("admin")) return "How much of my donation goes on admin?";
  if (o.includes("fatigue") || o.includes("christmas")) return "Why does this matter now, after Christmas?";
  if (o.includes("government")) return "Doesn't the government cover heating costs?";
  return `${objection.replace(/^(worried|assumes|thinks) (that )?/i, "")}?`.replace(/\?\?$/, "?");
}

function objectionToAnswer(objection: string, name: string, proofPoints: string[]): string {
  const o = objection.toLowerCase();
  if (o.includes("admin")) return `Most of what you give funds direct help: heating costs, repairs and home visits. ${name} publishes its accounts every year and we are happy to show you exactly how the appeal money was spent.`;
  if (o.includes("fatigue") || o.includes("christmas")) return `January and February are the coldest months and the point where winter bills land. The need peaks after the festive giving season ends, which is exactly why this appeal runs now.`;
  if (o.includes("government")) return `Government support helps, but it does not reach everyone and it rarely covers emergency repairs. ${name} fills the gap quickly and helps people claim everything they are entitled to. ${proofPoints[0] ?? ""}`.trim();
  return `${name} has answered this question many times. ${proofPoints[0] ?? ""} If you would like more detail, our team will happily talk you through it.`.trim();
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

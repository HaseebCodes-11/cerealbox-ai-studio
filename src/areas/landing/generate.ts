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
      `Creative context: ${brief.creativeContext.problemInDailyLife} ${brief.client.name} ${brief.creativeContext.whatWeDo} Case study: ${brief.creativeContext.caseStudy}`,
      `Audience objections to answer in the FAQ: ${brief.audience.objections.join("; ")}`,
      `Compliance notes: ${brief.client.complianceNotes.join("; ") || "none"}`,
      `Gift Aid eligible: ${brief.offer.giftAidEligible ? "yes" : "no"}.`,
      `Variant: ${variant}.`,
    ].join("\n"),
  mock: ({ brief, idea, copy, variant }) => buildMockLandingSpec(brief, idea, copy, variant),
});

export function buildMockLandingSpec(brief: CampaignBrief, idea: Idea, copy: CopyPack, variant: "A" | "B"): LandingPageSpec {
  const c = brief.client;
  const cc = brief.creativeContext;
  const tiers = brief.offer.donationTiers;
  const t0 = tiers[0]!;
  const a0 = formatCurrency(t0.amount, t0.currency);
  const match = brief.offer.matchFunding;
  const who = cc.beneficiarySingular;
  const headlineA = copy.headlines[0] ?? idea.title;
  const headlineB = match ? `Your gift goes twice as far right now` : (copy.headlines[1] ?? idea.hook);
  const headline = truncate(variant === "A" ? headlineA : headlineB, 80);

  const faq = brief.audience.objections.slice(0, 5).map((objection) => ({
    question: truncate(objectionToQuestion(objection), 120),
    answer: truncate(objectionToAnswer(objection, brief), 400),
  }));
  // A brief with few or no listed objections still needs a useful FAQ; pad with the questions every donor asks.
  const generic = [
    { question: "Is my donation secure?", answer: `Yes. Payments are processed by our regulated payment provider and ${c.name} never stores your card details.` },
    { question: "Can I give monthly instead?", answer: `Yes. Choose "Give monthly" on the form; you can change or stop your gift at any time by contacting ${c.name}.` },
    { question: "Will I get a receipt?", answer: `Yes. You will receive an email confirmation straight away, and ${c.name} will write to tell you what your gift made possible.` },
  ];
  for (const g of generic) if (faq.length < 2 && !faq.some((f) => f.question === g.question)) faq.push(g);

  const metaBase = `${a0} ${t0.impact}. ${match ? `${match}. ` : ""}Donate to ${c.name} today and help ${who}.`;
  const metaDescription = truncate(metaBase.length >= 50 ? metaBase : `${metaBase} ${c.cause}.`, 155);

  return {
    id: `landing-${idea.id}-${variant}`,
    ideaId: idea.id,
    variant,
    variantHypothesis: variant === "A" ? "Control: impact-led headline from the approved copy pack." : "Test: urgency/match-led headline lifts conversion rate without lowering average gift.",
    slug: slugify(`${brief.campaignName}-${variant}`),
    title: truncate(`${brief.offer.ask} | ${c.name}`, 60),
    metaDescription,
    hero: {
      headline,
      subheadline: truncate(`${a0} ${t0.impact}.${match ? ` ${match}.` : ""} Give in two minutes.`, 180),
      ctaLabel: `Donate ${a0}`,
      imagePrompt: `${idea.visualDirection} Warm natural light, documentary feel, no identifiable faces, space on the left for text.`,
      imageAlt: truncate(`${capitalise(cc.settingNoun)} scene representing ${c.name}'s work`, 125),
    },
    problem: {
      heading: "The problem, plainly",
      body: `${brief.keyMessage} ${cc.problemInDailyLife} ${c.name} ${cc.whatWeDo}`,
    },
    impact: tiers.map((t) => ({ amount: t.amount, label: truncate(capitalise(t.impact), 90) })),
    proof: c.proofPoints.slice(0, 4).map((text) => ({ text: truncate(text, 160) })),
    story: {
      heading: `What your gift changes for ${who}`,
      body: cc.caseStudy,
      attribution: truncate(`${c.name} team`, 60),
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
      headline: truncate(match ? `Give before ${brief.offer.deadline ?? "the deadline"} and your gift is doubled` : `Help ${who} today`, 90),
      ctaLabel: `Donate ${a0}`,
    },
  };
}

function objectionToQuestion(objection: string): string {
  const o = objection.toLowerCase();
  if (o.includes("admin")) return "How much of my donation goes on admin?";
  if (o.includes("fatigue") || o.includes("christmas")) return "Why does this matter now, after Christmas?";
  if (o.includes("government")) return "Doesn't the government already cover this?";
  if (o.includes("supermarket")) return "Don't supermarkets already donate enough?";
  if (o.includes("out of work") || o.includes("unemploy")) return "Isn't this only for people out of work?";
  return `${objection.replace(/^(worried|assumes|thinks) (that )?/i, "")}?`.replace(/\?\?$/, "?");
}

function objectionToAnswer(objection: string, brief: CampaignBrief): string {
  const o = objection.toLowerCase();
  const name = brief.client.name;
  const proof = brief.client.proofPoints;
  const impacts = brief.offer.donationTiers.map((t) => t.impact).join(", ");
  if (o.includes("admin")) return `Most of what you give funds direct help: ${impacts}. ${name} publishes its accounts every year and we are happy to show you exactly how the appeal money was spent.`;
  if (o.includes("fatigue") || o.includes("christmas")) return `The need does not stop when the giving season ends; for the people we support it usually peaks in the weeks after. That is exactly why this appeal runs now.`;
  if (o.includes("government")) return `Public support helps, but it does not reach everyone and it rarely covers emergencies. ${name} fills the gap quickly and helps people claim everything they are entitled to. ${proof[0] ?? ""}`.trim();
  if (o.includes("supermarket")) return `Surplus food helps, but it is unpredictable and rarely includes fresh produce. Your gift buys what is actually needed, when it is needed. ${proof[0] ?? ""}`.trim();
  if (o.includes("out of work") || o.includes("unemploy")) return `${proof.find((p) => /in work/i.test(p)) ?? proof[0] ?? ""} A tight week can become an empty cupboard for any family; ${name} is there when it does.`.trim();
  return `${name} has answered this question many times. ${proof[0] ?? ""} If you would like more detail, our team will happily talk you through it.`.trim();
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

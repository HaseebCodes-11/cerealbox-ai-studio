import { z } from "zod";

/**
 * A landing page is a spec first and HTML second. The spec is what the model
 * produces and what humans approve; rendering is deterministic. That keeps
 * design consistent, makes A/B variants trivially diffable, and lets checks
 * run on structure (one H1, CTA above the fold, Gift Aid statement present)
 * rather than on a blob of markup.
 */
export const DonationFormSchema = z.object({
  amounts: z.array(z.number().positive()).min(2).max(6),
  defaultAmount: z.number().positive(),
  frequencies: z.array(z.enum(["one-off", "monthly"])).min(1),
  giftAid: z.boolean(),
  currency: z.enum(["GBP", "USD", "EUR"]).default("GBP"),
  buttonLabel: z.string().min(3).max(40),
});

export const LandingPageSpecSchema = z.object({
  id: z.string().min(1),
  ideaId: z.string().min(1),
  variant: z.enum(["A", "B"]),
  variantHypothesis: z.string().min(5),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(10).max(60),
  metaDescription: z.string().min(50).max(155),
  hero: z.object({
    headline: z.string().min(5).max(80),
    subheadline: z.string().min(10).max(180),
    ctaLabel: z.string().min(3).max(30),
    imagePrompt: z.string().min(10),
    imageAlt: z.string().min(5).max(125),
  }),
  problem: z.object({ heading: z.string().min(5).max(80), body: z.string().min(40) }),
  impact: z.array(z.object({ amount: z.number().positive(), label: z.string().min(5).max(90) })).min(2),
  proof: z.array(z.object({ text: z.string().min(5).max(160) })).min(2).max(4),
  story: z.object({ heading: z.string().min(5).max(80), body: z.string().min(60), attribution: z.string().max(60).optional() }),
  faq: z.array(z.object({ question: z.string().min(5).max(120), answer: z.string().min(20).max(400) })).min(2).max(6),
  trust: z.array(z.string().min(3).max(80)).min(1).max(5),
  form: DonationFormSchema,
  closingCta: z.object({ headline: z.string().min(5).max(90), ctaLabel: z.string().min(3).max(30) }),
});

export type DonationForm = z.infer<typeof DonationFormSchema>;
export type LandingPageSpec = z.infer<typeof LandingPageSpecSchema>;

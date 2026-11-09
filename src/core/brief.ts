import { z } from "zod";

/**
 * The Campaign Brief is the single object that connects every area.
 * Ideas, copy, statics, scripts, UGC, landing pages and the media-buyer launch
 * plan all read from it, so a change to the offer or audience propagates
 * everywhere instead of being re-typed into nine tools.
 */

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a 6-digit hex colour");

export const BrandPaletteSchema = z.object({
  primary: hexColour,
  secondary: hexColour,
  accent: hexColour,
  text: hexColour,
  background: hexColour,
  fontFamily: z.string().default("Inter, Arial, sans-serif"),
});

export const BrandVoiceSchema = z.object({
  tone: z.array(z.string()).min(1),
  avoid: z.array(z.string()).default([]),
  exampleLines: z.array(z.string()).default([]),
});

export const AudienceSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  ageRange: z.string().optional(),
  motivations: z.array(z.string()).min(1),
  objections: z.array(z.string()).default([]),
});

export const DonationTierSchema = z.object({
  amount: z.number().positive(),
  currency: z.enum(["GBP", "USD", "EUR"]).default("GBP"),
  impact: z.string().min(1),
});

export const OfferSchema = z.object({
  ask: z.string().min(1),
  donationTiers: z.array(DonationTierSchema).min(1),
  matchFunding: z.string().optional(),
  deadline: z.string().optional(),
  giftAidEligible: z.boolean().default(true),
});

export const ClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cause: z.string().min(1),
  region: z.string().default("UK"),
  charityNumber: z.string().optional(),
  website: z.string().url(),
  brand: BrandPaletteSchema,
  voice: BrandVoiceSchema,
  proofPoints: z.array(z.string()).min(1),
  complianceNotes: z.array(z.string()).default([]),
});

export const ChannelSchema = z.enum(["meta_feed", "meta_stories", "meta_reels"]);

/**
 * Creative context: the handful of plain-English seeds a strategist writes
 * into a brief so generation is grounded in this cause rather than generic.
 * Every field has a safe default; the better these are, the better the output.
 * Word-count guidance keeps generated scripts inside their time budgets.
 */
export const CreativeContextSchema = z.object({
  /** "an older person", "a family", "a rescued dog" */
  beneficiarySingular: z.string().min(1).default("someone"),
  /** "older people", "families", "rescued dogs" */
  beneficiaryPlural: z.string().min(1).default("people"),
  /** One sentence, 8-14 words: what the problem looks like day to day. */
  problemInDailyLife: z.string().min(1).default("People are struggling quietly and most never ask for help."),
  /** One first-person line a supporter might say, 8-14 words. */
  storySeed: z.string().min(1).default("I did not realise how close to home this was until it happened to someone I know."),
  /** A question the audience is already half-asking, under 12 words. */
  openingQuestion: z.string().min(1).default("What would you do if this was someone you knew?"),
  /** An everyday spend to anchor the first tier against: "a takeaway", "two coffees". */
  everydayComparison: z.string().min(1).default("a takeaway"),
  /** Where the problem shows up on camera: "kitchen", "classroom", "beach". */
  settingNoun: z.string().min(1).default("home"),
  /** One sentence finishing "<Charity> ...": what the charity does about it. */
  whatWeDo: z.string().min(1).default("finds the people who need help and acts quickly."),
  /** 2-3 anonymised sentences for the landing page story. */
  caseStudy: z.string().min(1).default("Last year one of the people we support was coping alone. A visit from our team changed that within days. Names and details are changed to protect privacy; the case is real."),
  /** Footage keywords for scripts and clip matching. */
  brollKeywords: z.array(z.string()).min(3).default(["community", "volunteers", "hands", "front door", "team at work", "end card"]),
});

export type CreativeContext = z.infer<typeof CreativeContextSchema>;

export const CampaignBriefSchema = z.object({
  id: z.string().min(1),
  client: ClientSchema,
  campaignName: z.string().min(1),
  objective: z.enum(["donations", "regular_giving", "leads", "awareness"]),
  audience: AudienceSchema,
  offer: OfferSchema,
  keyMessage: z.string().min(1),
  channels: z.array(ChannelSchema).min(1),
  constraints: z
    .object({
      dailyBudgetGbp: z.number().positive().optional(),
      targetRoas: z.number().positive().optional(),
      targetCpaGbp: z.number().positive().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    })
    .default({}),
  creativeContext: CreativeContextSchema.prefault({}),
  references: z.array(z.string()).default([]),
});

export type BrandPalette = z.infer<typeof BrandPaletteSchema>;
export type BrandVoice = z.infer<typeof BrandVoiceSchema>;
export type Audience = z.infer<typeof AudienceSchema>;
export type DonationTier = z.infer<typeof DonationTierSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export function parseBrief(input: unknown): CampaignBrief {
  return CampaignBriefSchema.parse(input);
}

export function formatCurrency(amount: number, currency: DonationTier["currency"] = "GBP"): string {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : "€";
  return `${symbol}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

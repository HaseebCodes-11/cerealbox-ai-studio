/**
 * Meta ad text limits. "recommended" is where Meta starts truncating in most
 * placements; "max" is the hard cap. We validate against both: over the
 * recommended length is a warning, over the max is a blocker.
 */
export interface TextLimit {
  recommended: number;
  max: number;
  note: string;
}

export const META_TEXT_LIMITS = {
  primaryText: { recommended: 125, max: 2200, note: "Truncated with 'See more' after ~125 chars in feed." },
  headline: { recommended: 40, max: 255, note: "Truncates around 40 chars on mobile feed." },
  description: { recommended: 30, max: 255, note: "Only shown in some placements; keep very short." },
  storyOverlay: { recommended: 60, max: 120, note: "On-image text for Stories/Reels; must be readable at a glance." },
  hook: { recommended: 90, max: 160, note: "First line of primary text or first spoken line." },
} as const satisfies Record<string, TextLimit>;

export type CopyField = keyof typeof META_TEXT_LIMITS;

export const META_CTA_BUTTONS = ["DONATE_NOW", "LEARN_MORE", "SIGN_UP", "GET_QUOTE", "SUBSCRIBE", "WATCH_MORE"] as const;
export type MetaCtaButton = (typeof META_CTA_BUTTONS)[number];

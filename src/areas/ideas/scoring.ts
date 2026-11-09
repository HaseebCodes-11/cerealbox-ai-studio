import type { CampaignBrief } from "../../core/brief";
import { checkText } from "../../core/guardrails";
import type { Idea, IdeaFormat, RankedIdea } from "./types";

/**
 * Deterministic re-scoring of model-generated ideas. The model scores itself,
 * but we do not trust self-assessment alone:
 *  - novelty is recomputed against previous ideas (text similarity)
 *  - brand fit is penalised for banned words and guardrail issues
 *  - duplicates inside the batch are flagged and demoted
 * The weighted total is what the review screen sorts by.
 */
export const SCORE_WEIGHTS = {
  novelty: 0.3,
  clarity: 0.2,
  emotionalPull: 0.2,
  brandFit: 0.2,
  feasibility: 0.1,
} as const;

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

const STOPWORDS = new Set(["this", "that", "with", "from", "your", "what", "when", "they", "them", "their", "have", "will", "into", "than", "then", "about", "there", "here", "which", "would", "could", "should", "every", "some", "more", "most", "just", "like", "over", "under", "after", "before"]);

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ScoringOptions {
  previousIdeas?: string[];
  /** Similarity above this marks an idea as a duplicate (0-1). */
  duplicateThreshold?: number;
}

export function rankIdeas(ideas: Idea[], brief: CampaignBrief, options: ScoringOptions = {}): RankedIdea[] {
  const threshold = options.duplicateThreshold ?? 0.5;
  const previous = (options.previousIdeas ?? []).map(tokenSet);
  const seen: Array<{ id: string; tokens: Set<string> }> = [];
  const ranked: RankedIdea[] = [];

  for (const idea of ideas) {
    const text = `${idea.title} ${idea.hook} ${idea.concept}`;
    const tokens = tokenSet(text);

    const maxPrev = previous.reduce((m, p) => Math.max(m, jaccard(tokens, p)), 0);
    const novelty = clamp(idea.scores.novelty * (1 - maxPrev), 0, 10);

    let duplicateOf: string | undefined;
    for (const s of seen) {
      if (jaccard(tokens, s.tokens) >= threshold) {
        duplicateOf = s.id;
        break;
      }
    }
    seen.push({ id: idea.id, tokens });

    const guard = checkText(text, { avoidWords: brief.client.voice.avoid, allowedFacts: allowedFacts(brief) });
    const brandPenalty = guard.issues.reduce((p, i) => p + (i.severity === "block" ? 4 : i.severity === "warn" ? 1.5 : 0.5), 0);
    const brandFit = clamp(idea.scores.brandFit - brandPenalty, 0, 10);

    const scores = { ...idea.scores, novelty, brandFit };
    let total =
      scores.novelty * SCORE_WEIGHTS.novelty +
      scores.clarity * SCORE_WEIGHTS.clarity +
      scores.emotionalPull * SCORE_WEIGHTS.emotionalPull +
      scores.brandFit * SCORE_WEIGHTS.brandFit +
      scores.feasibility * SCORE_WEIGHTS.feasibility;
    if (duplicateOf) total *= 0.5;
    if (idea.riskFlags.length) total -= 0.25 * idea.riskFlags.length;

    ranked.push({ ...idea, scores, total: Math.round(total * 100) / 100, rank: 0, ...(duplicateOf ? { duplicateOf } : {}) });
  }

  ranked.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  ranked.forEach((r, i) => (r.rank = i + 1));
  return ranked;
}

/** Pick the top N ideas while guaranteeing angle diversity and format coverage. */
export function selectIdeas(ranked: RankedIdea[], count: number, requiredFormats: IdeaFormat[] = []): RankedIdea[] {
  const chosen: RankedIdea[] = [];
  const usedAngles = new Set<string>();
  for (const idea of ranked) {
    if (chosen.length >= count) break;
    if (idea.duplicateOf) continue;
    if (usedAngles.has(idea.angle)) continue;
    chosen.push(idea);
    usedAngles.add(idea.angle);
  }
  for (const format of requiredFormats) {
    if (chosen.some((c) => c.formats.includes(format))) continue;
    const candidate = ranked.find((r) => !r.duplicateOf && r.formats.includes(format) && !chosen.includes(r));
    if (candidate) {
      if (chosen.length >= count) chosen.pop();
      chosen.push(candidate);
    }
  }
  return chosen.sort((a, b) => a.rank - b.rank);
}

export function allowedFacts(brief: CampaignBrief): string[] {
  return [
    ...brief.client.proofPoints,
    ...brief.offer.donationTiers.flatMap((t) => [`£${t.amount}`, `$${t.amount}`, `€${t.amount}`, `£${t.amount * 2}`, t.impact]),
    brief.offer.matchFunding ?? "",
    brief.offer.deadline ?? "",
    brief.keyMessage,
    // UK Gift Aid is a statutory 25% uplift, so it is always a permitted fact.
    brief.offer.giftAidEligible ? "Gift Aid adds 25%" : "",
  ].filter(Boolean);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v * 10) / 10));
}

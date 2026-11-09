import { addDays, derive, sumMetrics, type AdMetricsDaily, type AdsDataset, type Derived } from "../../core/ads";
import type { RiskTier } from "../../core/review";
import type { Recommendation, RulesConfig } from "./types";

/**
 * Deterministic rules. The LLM never decides whether to pause an ad; it
 * explains and prioritises what the rules found. This keeps money decisions
 * auditable and testable, and lets a media buyer tune thresholds per client.
 */

export interface AdsetWindow {
  adsetId: string;
  campaignId: string;
  clientId: string;
  name: string;
  dailyBudgetGbp: number;
  status: "ACTIVE" | "PAUSED";
  learningStatus: "learning" | "learning_limited" | "active";
  targetRoas: number;
  targetCpaGbp: number;
  recent: Derived; // last N days
  previous: Derived; // the N days before that
  recent3: Derived; // last 3 days
  ads: Array<{ adId: string; name: string; creativeType: string; launchedOn: string; recent: Derived; previous: Derived }>;
}

export function buildWindows(data: AdsDataset, asOf: string, config: RulesConfig): AdsetWindow[] {
  const n = config.lookbackDays;
  const recentStart = addDays(asOf, -(n - 1));
  const prevStart = addDays(asOf, -(2 * n - 1));
  const prevEnd = addDays(asOf, -n);
  const recent3Start = addDays(asOf, -2);

  const inRange = (r: AdMetricsDaily, start: string, end: string) => r.date >= start && r.date <= end;
  const clientsById = new Map(data.clients.map((c) => [c.id, c]));

  return data.adsets.map((adset) => {
    const rows = data.metrics.filter((m) => m.adsetId === adset.id);
    const client = clientsById.get(adset.clientId);
    const ads = data.ads
      .filter((a) => a.adsetId === adset.id)
      .map((a) => {
        const adRows = rows.filter((r) => r.adId === a.id);
        return {
          adId: a.id,
          name: a.name,
          creativeType: a.creativeType,
          launchedOn: a.launchedOn,
          recent: derive(sumMetrics(adRows.filter((r) => inRange(r, recentStart, asOf)))),
          previous: derive(sumMetrics(adRows.filter((r) => inRange(r, prevStart, prevEnd)))),
        };
      });
    return {
      adsetId: adset.id,
      campaignId: adset.campaignId,
      clientId: adset.clientId,
      name: adset.name,
      dailyBudgetGbp: adset.dailyBudgetGbp,
      status: adset.status,
      learningStatus: adset.learningStatus,
      targetRoas: client?.targetRoas ?? 3,
      targetCpaGbp: client?.targetCpaGbp ?? 30,
      recent: derive(sumMetrics(rows.filter((r) => inRange(r, recentStart, asOf)))),
      previous: derive(sumMetrics(rows.filter((r) => inRange(r, prevStart, prevEnd)))),
      recent3: derive(sumMetrics(rows.filter((r) => inRange(r, recent3Start, asOf)))),
      ads,
    };
  });
}

type RuleFn = (w: AdsetWindow, config: RulesConfig, asOf: string) => Recommendation[];

const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const money = (n: number) => Math.round(n * 100) / 100;

function rec(
  w: AdsetWindow,
  asOf: string,
  partial: Omit<Recommendation, "id" | "status" | "createdOn" | "entity"> & { entity?: Recommendation["entity"] },
): Recommendation {
  const entity = partial.entity ?? { level: "adset", id: w.adsetId, name: w.name, clientId: w.clientId };
  return {
    id: `${partial.rule}:${entity.id}:${asOf}`,
    status: "proposed",
    createdOn: asOf,
    ...partial,
    entity,
  };
}

/** Tracking failure: meaningful spend and clicks, but zero conversions in the last 3 days when the previous week converted. */
export const ruleTrackingBreak: RuleFn = (w, config, asOf) => {
  if (w.status !== "ACTIVE") return [];
  const spent3 = w.recent3.spend;
  if (spent3 < config.minSpendForJudgementGbp * 0.5) return [];
  if (w.recent3.conversions === 0 && w.recent3.linkClicks > 50 && w.previous.conversions >= 5) {
    return [
      rec(w, asOf, {
        rule: "tracking-break",
        type: "investigate_tracking",
        title: `Possible tracking break on ${w.name}`,
        rationale: `£${money(spent3)} spent and ${w.recent3.linkClicks} link clicks in 3 days with zero recorded donations, after ${w.previous.conversions} last week. Check the pixel/CAPI and the donation platform webhook before touching budgets.`,
        evidence: { spend3d: money(spent3), linkClicks3d: w.recent3.linkClicks, conversions3d: 0, conversionsPrevWeek: w.previous.conversions },
        risk: "human",
        confidence: 0.85,
      }),
    ];
  }
  return [];
};

/** CPA spike vs the previous period with enough spend to judge. */
export const ruleCpaSpike: RuleFn = (w, config, asOf) => {
  if (w.status !== "ACTIVE" || w.recent.spend < config.minSpendForJudgementGbp || w.previous.conversions < 5) return [];
  if (w.recent.conversions === 0) return []; // handled by zero-conversion rules
  if (w.recent.cpa > w.previous.cpa * config.cpaSpikeMultiplier && w.recent.cpa > w.targetCpaGbp) {
    const step = Math.round(w.dailyBudgetGbp * (1 - config.budgetStepPct / 100));
    return [
      rec(w, asOf, {
        rule: "cpa-spike",
        type: "decrease_budget",
        title: `CPA up ${pct(w.recent.cpa, w.previous.cpa)}% on ${w.name}`,
        rationale: `CPA moved from £${w.previous.cpa} to £${w.recent.cpa} (target £${w.targetCpaGbp}) over the last ${config.lookbackDays} days on £${money(w.recent.spend)} spend. Recommend trimming budget ${config.budgetStepPct}% while creative is refreshed.`,
        evidence: { cpaRecent: w.recent.cpa, cpaPrevious: w.previous.cpa, targetCpa: w.targetCpaGbp, spendRecent: money(w.recent.spend) },
        risk: "approve",
        confidence: 0.7,
        proposedChange: { field: "daily_budget_gbp", from: w.dailyBudgetGbp, to: step },
      }),
    ];
  }
  return [];
};

/** ROAS below floor for the whole lookback window. */
export const ruleRoasFloor: RuleFn = (w, config, asOf) => {
  if (w.status !== "ACTIVE" || w.recent.spend < config.minSpendForJudgementGbp) return [];
  const floor = w.targetRoas * config.roasFloorMultiplier;
  if (w.recent.roas < floor && w.recent.conversions > 0) {
    const severe = w.recent.roas < floor * 0.5;
    return [
      rec(w, asOf, {
        rule: "roas-floor",
        type: severe ? "pause_adset" : "decrease_budget",
        title: `ROAS ${w.recent.roas} vs target ${w.targetRoas} on ${w.name}`,
        rationale: `${config.lookbackDays}-day ROAS is ${w.recent.roas} against a floor of ${money(floor)} on £${money(w.recent.spend)} spend. ${severe ? "Recommend pausing the ad set." : `Recommend a ${config.budgetStepPct}% budget reduction and a creative review.`}`,
        evidence: { roasRecent: w.recent.roas, roasFloor: money(floor), targetRoas: w.targetRoas, spendRecent: money(w.recent.spend) },
        risk: severe ? "human" : "approve",
        confidence: severe ? 0.8 : 0.65,
        proposedChange: severe
          ? { field: "status", from: "ACTIVE", to: "PAUSED" }
          : { field: "daily_budget_gbp", from: w.dailyBudgetGbp, to: Math.round(w.dailyBudgetGbp * (1 - config.budgetStepPct / 100)) },
      }),
    ];
  }
  return [];
};

/** Winner: ROAS well above target with stable CPA -> scale budget in steps, inside caps. */
export const ruleScaleWinner: RuleFn = (w, config, asOf) => {
  if (w.status !== "ACTIVE" || w.recent.spend < config.minSpendForJudgementGbp || w.recent.conversions < 10) return [];
  if (w.recent.roas >= w.targetRoas * config.roasScaleMultiplier && w.recent.cpa <= w.targetCpaGbp && w.learningStatus === "active") {
    const to = Math.min(config.maxDailyBudgetGbp, Math.round(w.dailyBudgetGbp * (1 + config.budgetStepPct / 100)));
    if (to <= w.dailyBudgetGbp) return [];
    return [
      rec(w, asOf, {
        rule: "scale-winner",
        type: "increase_budget",
        title: `Scale ${w.name}: ROAS ${w.recent.roas} at CPA £${w.recent.cpa}`,
        rationale: `ROAS ${w.recent.roas} is ${pct(w.recent.roas, w.targetRoas)}% above target with CPA inside target over ${w.recent.conversions} donations. Recommend +${config.budgetStepPct}% budget (£${w.dailyBudgetGbp} -> £${to}); a single step avoids resetting learning.`,
        evidence: { roasRecent: w.recent.roas, targetRoas: w.targetRoas, cpaRecent: w.recent.cpa, conversions: w.recent.conversions },
        risk: "approve",
        confidence: 0.75,
        proposedChange: { field: "daily_budget_gbp", from: w.dailyBudgetGbp, to },
      }),
    ];
  }
  return [];
};

/** Creative fatigue at ad level: frequency over cap and CTR falling. */
export const ruleCreativeFatigue: RuleFn = (w, config, asOf) => {
  const out: Recommendation[] = [];
  for (const ad of w.ads) {
    if (ad.recent.spend < config.minSpendForJudgementGbp * 0.5 || ad.previous.impressions < 1000) continue;
    const ctrDrop = -pct(ad.recent.ctr, ad.previous.ctr);
    if (ad.recent.frequency >= config.frequencyCap && ctrDrop >= config.ctrDropPct) {
      out.push(
        rec(w, asOf, {
          rule: "creative-fatigue",
          type: "refresh_creative",
          entity: { level: "ad", id: ad.adId, name: ad.name, clientId: w.clientId },
          title: `Creative fatigue: ${ad.name}`,
          rationale: `Frequency ${ad.recent.frequency} (cap ${config.frequencyCap}) and CTR down ${ctrDrop}% week on week (${ad.previous.ctr}% -> ${ad.recent.ctr}%). Queue a refresh from the idea bank and pause this ad once the replacement is live.`,
          evidence: { frequency: ad.recent.frequency, ctrRecent: ad.recent.ctr, ctrPrevious: ad.previous.ctr, ctrDropPct: ctrDrop },
          risk: "approve",
          confidence: 0.7,
          proposedChange: { field: "status", from: "ACTIVE", to: "PAUSED" },
        }),
      );
    }
  }
  return out;
};

/** Zero conversions after spending several CPAs' worth at ad level -> pause the ad. */
export const ruleZeroConversionAd: RuleFn = (w, config, asOf) => {
  const out: Recommendation[] = [];
  if (w.status !== "ACTIVE") return out;
  for (const ad of w.ads) {
    const threshold = w.targetCpaGbp * config.zeroConversionSpendMultiplier;
    if (ad.recent.conversions === 0 && ad.recent.spend >= threshold && w.recent.conversions > 0) {
      out.push(
        rec(w, asOf, {
          rule: "zero-conversion-ad",
          type: "pause_ad",
          entity: { level: "ad", id: ad.adId, name: ad.name, clientId: w.clientId },
          title: `No donations from ${ad.name} after £${money(ad.recent.spend)}`,
          rationale: `£${money(ad.recent.spend)} spent (over ${config.zeroConversionSpendMultiplier}x the £${w.targetCpaGbp} target CPA) with zero donations while sibling ads convert. Recommend pausing and reallocating.`,
          evidence: { spendRecent: money(ad.recent.spend), threshold: money(threshold), adsetConversions: w.recent.conversions },
          risk: "approve",
          confidence: 0.8,
          proposedChange: { field: "status", from: "ACTIVE", to: "PAUSED" },
        }),
      );
    }
  }
  return out;
};

/**
 * Learning limited: Meta reports this status itself; we trust it. For ad sets
 * still in "learning" we add the weekly-conversions heuristic so a buyer sees
 * it before Meta flags it. Ad sets Meta marks "active" are left alone.
 */
export const ruleLearningLimited: RuleFn = (w, config, asOf) => {
  if (w.status !== "ACTIVE") return [];
  const weekly = Math.round((w.recent.conversions / config.lookbackDays) * 7);
  if (w.learningStatus === "learning_limited" || (w.learningStatus === "learning" && weekly < config.learningLimitedWeeklyConversions && w.recent.spend >= config.minSpendForJudgementGbp)) {
    return [
      rec(w, asOf, {
        rule: "learning-limited",
        type: "exit_learning_limited",
        title: `${w.name} is learning limited (${weekly} donations/week)`,
        rationale: `Meta needs ~${config.learningLimitedWeeklyConversions} conversions a week per ad set to optimise. Options: consolidate ad sets, broaden the audience, or optimise for a higher-volume event (e.g. landing page view or add payment info) while keeping ROAS reporting on donations.`,
        evidence: { weeklyConversions: weekly, learningStatus: w.learningStatus, spendRecent: money(w.recent.spend) },
        risk: "human",
        confidence: 0.6,
      }),
    ];
  }
  return [];
};

export const ALL_RULES: RuleFn[] = [ruleTrackingBreak, ruleCpaSpike, ruleRoasFloor, ruleScaleWinner, ruleCreativeFatigue, ruleZeroConversionAd, ruleLearningLimited];

export function evaluateRules(windows: AdsetWindow[], config: RulesConfig, asOf: string, rules: RuleFn[] = ALL_RULES): Recommendation[] {
  const out: Recommendation[] = [];
  for (const w of windows) {
    const found: Recommendation[] = [];
    for (const rule of rules) found.push(...rule(w, config, asOf));
    // A tracking break makes every other signal on that ad set unreliable: suppress them.
    if (found.some((r) => r.rule === "tracking-break")) {
      out.push(...found.filter((r) => r.rule === "tracking-break"));
    } else {
      out.push(...dedupeByEntityAndType(found));
    }
  }
  return out.sort((a, b) => riskOrder(b.risk) - riskOrder(a.risk) || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

/** Two rules proposing the same change on the same entity collapse into the more confident one. */
export function dedupeByEntityAndType(recs: Recommendation[]): Recommendation[] {
  const best = new Map<string, Recommendation>();
  for (const r of recs) {
    const key = `${r.entity.id}:${r.type}`;
    const existing = best.get(key);
    if (!existing || r.confidence > existing.confidence) best.set(key, r);
  }
  return [...best.values()];
}

export function riskOrder(risk: RiskTier): number {
  return risk === "human" ? 3 : risk === "approve" ? 2 : 1;
}

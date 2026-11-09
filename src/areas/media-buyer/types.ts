import { z } from "zod";
import type { RiskTier } from "../../core/review";

export const RECOMMENDATION_TYPES = [
  "pause_ad",
  "pause_adset",
  "increase_budget",
  "decrease_budget",
  "refresh_creative",
  "investigate_tracking",
  "exit_learning_limited",
  "notify",
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export interface EntityRef {
  level: "ad" | "adset" | "campaign" | "client";
  id: string;
  name: string;
  clientId: string;
}

export interface ProposedChange {
  field: "status" | "daily_budget_gbp";
  from: string | number;
  to: string | number;
}

export type RecommendationStatus = "proposed" | "approved" | "rejected" | "executed" | "auto_executed" | "failed";

export interface Recommendation {
  id: string;
  rule: string;
  type: RecommendationType;
  entity: EntityRef;
  title: string;
  rationale: string;
  evidence: Record<string, number | string>;
  risk: RiskTier;
  confidence: number; // 0-1
  proposedChange?: ProposedChange;
  status: RecommendationStatus;
  createdOn: string;
}

export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  entityIds: string[];
  clientId: string;
  channel: "slack" | "email";
}

export interface ActionResult {
  recommendationId: string;
  ok: boolean;
  dryRun: boolean;
  detail: string;
}

/** Thresholds a media buyer would tune per client; defaults are sensible for UK charity acquisition. */
export const RulesConfigSchema = z.object({
  minSpendForJudgementGbp: z.number().positive().default(100),
  lookbackDays: z.number().int().positive().default(7),
  cpaSpikeMultiplier: z.number().positive().default(1.5),
  roasFloorMultiplier: z.number().positive().default(0.7),
  roasScaleMultiplier: z.number().positive().default(1.3),
  frequencyCap: z.number().positive().default(3.5),
  ctrDropPct: z.number().positive().default(30),
  learningLimitedWeeklyConversions: z.number().int().positive().default(50),
  zeroConversionSpendMultiplier: z.number().positive().default(3),
  budgetStepPct: z.number().positive().default(20),
  maxAutoBudgetChangePct: z.number().positive().default(20),
  maxDailyBudgetGbp: z.number().positive().default(1000),
});
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

/**
 * Autonomy ladder. We start at "assist" for every client and move up only
 * after the agent's recommendations have been accepted consistently.
 *  - assist:    everything is a recommendation; humans do everything.
 *  - copilot:   "auto" tier actions (notifications) run; "approve" tier is one click.
 *  - autopilot: "approve" tier (small budget moves) executes automatically inside caps; "human" tier still waits.
 */
export type AutonomyLevel = "assist" | "copilot" | "autopilot";

export interface MetaAdsClient {
  readonly name: string;
  updateAdsetBudget(adsetId: string, dailyBudgetGbp: number): Promise<{ ok: boolean; detail: string }>;
  pauseAd(adId: string): Promise<{ ok: boolean; detail: string }>;
  pauseAdset(adsetId: string): Promise<{ ok: boolean; detail: string }>;
}

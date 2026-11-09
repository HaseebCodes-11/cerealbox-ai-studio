import type { CampaignBrief } from "../core/brief";
import { checkText } from "../core/guardrails";
import type { LLMProvider } from "../core/llm/provider";
import { PolicyReviewer } from "../core/review";
import { runCampaignPipeline, type CampaignPackage } from "../orchestrator";
import { MockMetaAdsClient, runMediaBuyerAgent } from "../areas/media-buyer";
import { generateMockDataset } from "../areas/toast";

/**
 * Evaluation harness. Three kinds of check, run on every change to a prompt,
 * a rule or a model version:
 *  1. Guardrail red team: known-bad copy MUST be caught, known-good MUST pass.
 *  2. Pipeline quality scorecard: how much of the generated material survives QA.
 *  3. Agent scenario recall: every injected ad-account scenario MUST be detected.
 * In production the same harness runs in CI with LLM_PROVIDER=anthropic on a
 * small golden set, and a nightly LLM-as-judge pass scores creative quality.
 */

export interface RedTeamCase {
  name: string;
  text: string;
  expectRules: string[]; // rules that must fire
  expectOk: boolean; // whether the text should pass (no blockers)
}

export const RED_TEAM_CASES: RedTeamCase[] = [
  { name: "guarantee claim", text: "We guarantee your £30 will keep someone warm all winter. Donate now.", expectRules: ["claims.guarantee"], expectOk: false },
  { name: "cure claim", text: "Your gift cures loneliness for older people. Give today.", expectRules: ["claims.cure"], expectOk: false },
  { name: "placeholder left in", text: "Help [CHARITY NAME] keep older people warm. Donate £30 today.", expectRules: ["placeholder"], expectOk: false },
  { name: "email leaked into copy", text: "Questions? Email jane.doe@example.org. Donate £30 today.", expectRules: ["pii.email"], expectOk: false },
  { name: "invented statistic", text: "97% of older people in Leeds are cold tonight. Donate £30.", expectRules: ["facts.unverified"], expectOk: true },
  { name: "guilt pressure", text: "They will die without you. Donate now.", expectRules: ["pressure.guilt"], expectOk: true },
  { name: "obligation pressure", text: "You must give today. There is no excuse. Donate.", expectRules: ["pressure.obligation"], expectOk: true },
  { name: "US tax framing", text: "Your donation is tax deductible. Give £30 today.", expectRules: ["claims.tax-deductible"], expectOk: true },
  { name: "clean copy", text: "£30 covers a week of heating for one household. Donate today and help an older person stay warm.", expectRules: [], expectOk: true },
  { name: "banned brand word", text: "Help the elderly stay warm this winter. Donate £30.", expectRules: ["voice.avoid"], expectOk: true },
];

export interface RedTeamResult {
  name: string;
  passed: boolean;
  firedRules: string[];
  missing: string[];
  okMismatch: boolean;
}

export function runRedTeam(brief: CampaignBrief, cases: RedTeamCase[] = RED_TEAM_CASES): RedTeamResult[] {
  const allowed = ["£30 covers a week of heating for one household", "£30", "£75", "£150"];
  return cases.map((c) => {
    const report = checkText(c.text, { allowedFacts: allowed, avoidWords: brief.client.voice.avoid, requireCta: false });
    const fired = report.issues.map((i) => i.rule);
    const missing = c.expectRules.filter((r) => !fired.includes(r));
    const okMismatch = report.ok !== c.expectOk;
    return { name: c.name, passed: missing.length === 0 && !okMismatch, firedRules: [...new Set(fired)], missing, okMismatch };
  });
}

export interface Scorecard {
  status: CampaignPackage["status"];
  copyScore: number;
  copyVariantsKept: number;
  copyVariantsTotal: number;
  creativesPassing: number;
  creativesTotal: number;
  scriptsPassing: number;
  scriptsTotal: number;
  landingPassing: number;
  landingTotal: number;
  ideaAngles: number;
  duplicateIdeas: number;
  gatesApproved: number;
  gatesTotal: number;
  estimatedCostUsd: number;
}

export async function runPipelineScorecard(brief: CampaignBrief, provider: LLMProvider): Promise<Scorecard> {
  const pkg = await runCampaignPipeline({ brief, provider, reviewer: new PolicyReviewer() });
  const copyTotal = pkg.copy ? pkg.copy.validation.fields.length : 0;
  return {
    status: pkg.status,
    copyScore: pkg.copy?.validation.overall.score ?? 0,
    copyVariantsKept: copyTotal - (pkg.copy?.validation.removed.length ?? 0),
    copyVariantsTotal: copyTotal,
    creativesPassing: pkg.creatives.filter((c) => c.report.ok).length,
    creativesTotal: pkg.creatives.length,
    scriptsPassing: pkg.scripts.filter((s) => s.report.ok).length,
    scriptsTotal: pkg.scripts.length,
    landingPassing: pkg.landing.filter((l) => l.report.ok).length,
    landingTotal: pkg.landing.length,
    ideaAngles: new Set(pkg.ideas.ranked.map((i) => i.angle)).size,
    duplicateIdeas: pkg.ideas.ranked.filter((i) => i.duplicateOf).length,
    gatesApproved: pkg.gates.filter((g) => g.decision === "approved").length,
    gatesTotal: pkg.gates.length,
    estimatedCostUsd: pkg.audit.totals().costUsd,
  };
}

/** Which rule must fire on which injected scenario entity. */
export const AGENT_SCENARIOS: Array<{ rule: string; entityId: string; label: string }> = [
  { rule: "scale-winner", entityId: "hearthline-c1-as1", label: "winner to scale" },
  { rule: "creative-fatigue", entityId: "hearthline-c1-as2-ad1", label: "fatigued static" },
  { rule: "tracking-break", entityId: "bluewater-c1-as1", label: "tracking break" },
  { rule: "cpa-spike", entityId: "kindred-c1-as1", label: "CPA spike" },
  { rule: "roas-floor", entityId: "northlight-c1-as1", label: "ROAS below floor" },
  { rule: "zero-conversion-ad", entityId: "paws-c1-as1-ad2", label: "dead ad" },
  { rule: "learning-limited", entityId: "brightstart-c1-as1", label: "learning limited" },
];

export interface AgentRecall {
  detected: Array<{ label: string; rule: string; entityId: string; found: boolean }>;
  recall: number;
  falsePositives: number;
  totalRecommendations: number;
}

export async function runAgentRecall(provider: LLMProvider, asOf = "2026-11-08"): Promise<AgentRecall> {
  const data = generateMockDataset({ asOf });
  const run = await runMediaBuyerAgent({ data, asOf, provider, adsClient: new MockMetaAdsClient(), autonomy: "assist", dryRun: true });
  const detected = AGENT_SCENARIOS.map((s) => ({ ...s, found: run.recommendations.some((r) => r.rule === s.rule && r.entity.id === s.entityId) }));
  const expectedKeys = new Set(AGENT_SCENARIOS.map((s) => `${s.rule}:${s.entityId}`));
  const falsePositives = run.recommendations.filter((r) => !expectedKeys.has(`${r.rule}:${r.entity.id}`)).length;
  return { detected, recall: detected.filter((d) => d.found).length / detected.length, falsePositives, totalRecommendations: run.recommendations.length };
}

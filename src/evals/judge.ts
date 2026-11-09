import { z } from "zod";
import type { CampaignBrief } from "../core/brief";
import { checkText } from "../core/guardrails";
import { defineTask, type LLMProvider } from "../core/llm/provider";
import { readingGrade } from "../core/text";
import { allowedFacts } from "../areas/ideas/scoring";
import type { CampaignPackage } from "../orchestrator";

/**
 * LLM-as-judge for creative quality. Guardrails catch what is wrong; the
 * judge estimates what is good: clarity, specificity, emotional pull and
 * brand fit on a 1-10 rubric with a ship / revise / reject verdict.
 * In production this runs on a cheaper model (Haiku 5.5) over a nightly
 * sample, and human spot checks calibrate it. The mock is heuristic so the
 * eval harness has a stable baseline to compare the real judge against.
 */
export const JudgementSchema = z.object({
  clarity: z.number().min(1).max(10),
  specificity: z.number().min(1).max(10),
  emotionalPull: z.number().min(1).max(10),
  brandFit: z.number().min(1).max(10),
  overall: z.number().min(1).max(10),
  strengths: z.array(z.string()).max(4),
  weaknesses: z.array(z.string()).max(4),
  verdict: z.enum(["ship", "revise", "reject"]),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export type ArtefactType = "idea" | "copy" | "script" | "landing";

export interface JudgeInput {
  brief: CampaignBrief;
  artefactType: ArtefactType;
  text: string;
}

export const judgeTask = defineTask<JudgeInput, Judgement>({
  name: "evals.judge",
  description: "Score a creative artefact on a quality rubric",
  schema: JudgementSchema,
  system: `You are a demanding creative director at a charity performance agency reviewing AI-assisted work.
Score 1-10 on: clarity (could a tired person on a phone get it in two seconds), specificity (real numbers, real details from the brief, nothing generic), emotional pull (does it make someone care without guilt or shock), brand fit (voice, banned words, regulator-safe).
Overall is your honest judgement, not an average. Verdict: ship (>= 7.5), revise (5.5-7.4), reject (< 5.5). List up to 4 strengths and 4 weaknesses, each one short sentence.`,
  effort: "low",
  prompt: ({ brief, artefactType, text }) =>
    [
      `Client: ${brief.client.name} (${brief.client.cause}). Voice: ${brief.client.voice.tone.join(", ")}. Banned words: ${brief.client.voice.avoid.join(", ") || "none"}.`,
      `Audience: ${brief.audience.description}.`,
      `Proof points: ${brief.client.proofPoints.join(" | ")}`,
      `Artefact type: ${artefactType}.`,
      `Artefact:\n${text}`,
    ].join("\n"),
  mock: ({ brief, artefactType, text }) => heuristicJudgement(brief, artefactType, text),
});

export function heuristicJudgement(brief: CampaignBrief, artefactType: ArtefactType, text: string): Judgement {
  const cc = brief.creativeContext;
  const lower = text.toLowerCase();
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Specificity: numbers from the brief, tier impacts, proof points, beneficiary named.
  const facts = allowedFacts(brief).map((f) => f.toLowerCase());
  const factHits = facts.filter((f) => f.length > 3 && lower.includes(f)).length;
  const money = (text.match(/£\s?\d/g) ?? []).length;
  const beneficiary = lower.includes(cc.beneficiarySingular.toLowerCase()) || lower.includes(cc.beneficiaryPlural.toLowerCase());
  let specificity = clamp(4 + Math.min(3, factHits) + Math.min(2, money) + (beneficiary ? 1 : 0));
  if (factHits >= 2) strengths.push("Cites concrete facts from the brief.");
  else weaknesses.push("Could cite one more concrete fact from the brief.");
  if (money === 0 && artefactType !== "idea") weaknesses.push("No specific amount; the ask is abstract.");

  // Clarity: reading grade and sentence length.
  const grade = readingGrade(text);
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const longest = Math.max(0, ...sentences.map((s) => s.split(/\s+/).length));
  let clarity = clamp(grade <= 7 ? 9 : grade <= 9 ? 8 : grade <= 11 ? 6 : 4);
  if (longest > 28) {
    clarity = clamp(clarity - 2);
    weaknesses.push("One sentence runs long for a phone screen.");
  } else strengths.push("Short sentences that read at a glance.");

  // Emotional pull: a person, a moment, a question or first person.
  const person = beneficiary || /\b(my|nan|mum|neighbour|dad|family|neighbor)\b/i.test(text);
  const question = text.includes("?");
  const story = lower.includes(cc.storySeed.toLowerCase().slice(0, 20)) || lower.includes(cc.problemInDailyLife.toLowerCase().slice(0, 20));
  let emotionalPull = clamp(5 + (person ? 2 : 0) + (question ? 1 : 0) + (story ? 2 : 0));
  if (story) strengths.push("Grounded in a real-feeling moment rather than a mission statement.");
  if (!person) weaknesses.push("Nobody in it; add a person or a moment.");

  // Brand fit: guardrails and banned words.
  const report = checkText(text, { allowedFacts: allowedFacts(brief), avoidWords: brief.client.voice.avoid });
  const blocks = report.issues.filter((i) => i.severity === "block").length;
  const warns = report.issues.filter((i) => i.severity === "warn").length;
  let brandFit = clamp(10 - blocks * 5 - warns * 2);
  if (blocks) weaknesses.push("Contains a blocked claim or placeholder.");
  else if (warns) weaknesses.push("Has guardrail warnings a reviewer must accept.");
  else strengths.push("Clean against brand and regulator guardrails.");

  const overall = Math.round((clarity * 0.25 + specificity * 0.3 + emotionalPull * 0.25 + brandFit * 0.2) * 10) / 10;
  const verdict: Judgement["verdict"] = overall >= 7.5 ? "ship" : overall >= 5.5 ? "revise" : "reject";
  return { clarity, specificity, emotionalPull, brandFit, overall, strengths: strengths.slice(0, 4), weaknesses: weaknesses.slice(0, 4), verdict };
}

export interface PackageJudgement {
  items: Array<{ artefactType: ArtefactType; label: string; judgement: Judgement }>;
  meanOverall: number;
  verdictCounts: Record<Judgement["verdict"], number>;
}

/** Judge the primary artefacts of a campaign package. */
export async function judgePackage(pkg: CampaignPackage, provider: LLMProvider): Promise<PackageJudgement> {
  const items: PackageJudgement["items"] = [];
  const brief = pkg.brief;
  const run = async (artefactType: ArtefactType, label: string, text: string) => {
    const result = await provider.run(judgeTask, { brief, artefactType, text });
    pkg.audit.record("llm_call", "evals", `judge:${artefactType}`, { label }, result.usage);
    items.push({ artefactType, label, judgement: result.output });
  };
  if (pkg.ideas.primary) await run("idea", pkg.ideas.primary.title, `${pkg.ideas.primary.hook}\n${pkg.ideas.primary.concept}`);
  const short = pkg.copy?.pack.primaryTexts.find((p) => p.variant === "short") ?? pkg.copy?.pack.primaryTexts[0];
  if (short) await run("copy", `primary text (${short.variant})`, short.text);
  const script = pkg.scripts.find((s) => s.report.ok)?.script;
  if (script) await run("script", script.title, script.beats.map((b) => b.voiceover).join(" "));
  const landing = pkg.landing[0]?.spec;
  if (landing) await run("landing", `landing ${landing.variant} hero`, `${landing.hero.headline}. ${landing.hero.subheadline} ${landing.problem.body}`);

  const meanOverall = items.length ? Math.round((items.reduce((s, i) => s + i.judgement.overall, 0) / items.length) * 10) / 10 : 0;
  const verdictCounts = { ship: 0, revise: 0, reject: 0 } as Record<Judgement["verdict"], number>;
  for (const i of items) verdictCounts[i.judgement.verdict]++;
  return { items, meanOverall, verdictCounts };
}

function clamp(v: number): number {
  return Math.max(1, Math.min(10, Math.round(v)));
}

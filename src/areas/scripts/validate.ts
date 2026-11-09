import type { CampaignBrief } from "../../core/brief";
import { checkText, scoreIssues, type GuardrailIssue, type GuardrailReport } from "../../core/guardrails";
import { countWords, spokenSeconds } from "../../core/text";
import { allowedFacts } from "../ideas/scoring";
import type { Script } from "./types";

/** Automated script QA: pacing, structure, duration and the shared text guardrails. */
export function validateScript(script: Script, brief: CampaignBrief): GuardrailReport {
  const issues: GuardrailIssue[] = [];
  const beats = script.beats;

  const hook = beats.find((b) => b.name === "hook");
  if (!hook) issues.push({ rule: "structure.hook", severity: "block", message: "Script has no hook beat." });
  else {
    if (beats[0]?.name !== "hook") issues.push({ rule: "structure.hook-first", severity: "warn", message: "Hook is not the first beat." });
    if (countWords(hook.voiceover) > 16) issues.push({ rule: "pacing.hook-length", severity: "warn", message: `Hook is ${countWords(hook.voiceover)} words; aim for under 12 so it lands in 3 seconds.` });
    if (hook.seconds > 4) issues.push({ rule: "pacing.hook-seconds", severity: "warn", message: "Hook runs longer than 4 seconds." });
  }

  const last = beats[beats.length - 1];
  if (!last || last.name !== "cta") issues.push({ rule: "structure.cta-last", severity: "warn", message: "Script does not end on a CTA beat." });

  const planned = beats.reduce((s, b) => s + b.seconds, 0);
  const tolerance = script.targetSeconds * 0.15;
  if (Math.abs(planned - script.targetSeconds) > tolerance) {
    issues.push({ rule: "duration.planned", severity: "warn", message: `Beats add up to ${planned.toFixed(1)}s against a ${script.targetSeconds}s target.` });
  }

  const spoken = beats.reduce((s, b) => s + spokenSeconds(b.voiceover), 0);
  // 150 wpm is a conservative pace; presenters comfortably hit 160-170, so allow 10% over before warning.
  if (spoken > script.targetSeconds * 1.2) {
    issues.push({ rule: "duration.voiceover", severity: "block", message: `Voiceover needs ~${spoken.toFixed(1)}s at 150 wpm, too long for ${script.targetSeconds}s.` });
  } else if (spoken > script.targetSeconds * 1.1) {
    issues.push({ rule: "duration.voiceover", severity: "warn", message: `Voiceover is tight: ~${spoken.toFixed(1)}s for a ${script.targetSeconds}s cut.` });
  }

  for (const beat of beats) {
    if (!(beat.seconds > 0) || !Number.isFinite(beat.seconds)) issues.push({ rule: "beat.seconds", severity: "block", message: `Beat ${beat.name} has a duration of ${beat.seconds}s; every beat needs positive time.` });
    if (!beat.visual.trim()) issues.push({ rule: "beat.visual", severity: "block", message: `Beat ${beat.name} has no visual direction.` });
    if (beat.onScreenText.length > 80) issues.push({ rule: "beat.text-length", severity: "warn", message: `On-screen text in ${beat.name} is over 80 characters.` });
  }

  const fullText = beats.map((b) => `${b.voiceover} ${b.onScreenText}`).join(" ");
  const textReport = checkText(fullText, { allowedFacts: allowedFacts(brief), avoidWords: brief.client.voice.avoid, requireCta: true, maxReadingGrade: 8 });
  issues.push(...textReport.issues);

  if (script.disclosureRequired && script.style !== "ugc-testimonial" && script.style !== "founder-direct") {
    issues.push({ rule: "disclosure.unexpected", severity: "info", message: "Disclosure flagged on a non-presenter script; check if intended." });
  }

  return { ok: !issues.some((i) => i.severity === "block"), issues, score: scoreIssues(issues) };
}

export function scriptToMarkdown(script: Script): string {
  const rows = script.beats.map((b) => `| ${b.name} | ${b.seconds}s | ${b.voiceover} | ${b.onScreenText} | ${b.visual} |`);
  return [
    `### ${script.title}`,
    ``,
    `Style: ${script.style} · Target: ${script.targetSeconds}s (est. ${script.estimatedSeconds}s) · Aspect: ${script.aspect} · Captions: ${script.captionStyle} · Music: ${script.musicMood}`,
    script.disclosureRequired ? `> Requires AI/synthetic media disclosure if produced with a synthetic presenter.` : ``,
    ``,
    `| Beat | Time | Voiceover | On-screen text | Visual |`,
    `|---|---|---|---|---|`,
    ...rows,
  ].join("\n");
}

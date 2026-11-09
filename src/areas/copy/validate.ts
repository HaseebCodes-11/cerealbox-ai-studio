import type { CampaignBrief } from "../../core/brief";
import { checkText, mergeReports, type GuardrailReport } from "../../core/guardrails";
import { allowedFacts } from "../ideas/scoring";
import { META_TEXT_LIMITS, type CopyField } from "./limits";
import type { CopyPack } from "./types";

export interface FieldReport {
  field: CopyField | "messagingPillars";
  index: number;
  text: string;
  report: GuardrailReport;
}

export interface CopyValidation {
  overall: GuardrailReport;
  fields: FieldReport[];
  /** The pack with blocked variants removed. */
  cleaned: CopyPack;
  removed: FieldReport[];
}

export function validateCopy(pack: CopyPack, brief: CampaignBrief): CopyValidation {
  const facts = allowedFacts(brief);
  const avoid = brief.client.voice.avoid;
  const fields: FieldReport[] = [];

  const run = (field: FieldReport["field"], index: number, text: string, opts: Parameters<typeof checkText>[1]) => {
    const report = checkText(text, { allowedFacts: facts, avoidWords: avoid, ...opts });
    fields.push({ field, index, text, report });
    return report;
  };

  pack.hooks.forEach((h, i) => run("hook", i, h, { maxChars: META_TEXT_LIMITS.hook.max, recommendedChars: META_TEXT_LIMITS.hook.recommended }));
  pack.headlines.forEach((h, i) => run("headline", i, h, { maxChars: META_TEXT_LIMITS.headline.max, recommendedChars: META_TEXT_LIMITS.headline.recommended }));
  pack.primaryTexts.forEach((p, i) =>
    run("primaryText", i, p.text, {
      maxChars: META_TEXT_LIMITS.primaryText.max,
      recommendedChars: p.variant === "short" ? META_TEXT_LIMITS.primaryText.recommended : undefined,
      requireCta: true,
    }),
  );
  pack.descriptions.forEach((d, i) => run("description", i, d, { maxChars: META_TEXT_LIMITS.description.max, recommendedChars: META_TEXT_LIMITS.description.recommended }));
  pack.storyOverlays.forEach((s, i) => run("storyOverlay", i, s, { maxChars: META_TEXT_LIMITS.storyOverlay.max, recommendedChars: META_TEXT_LIMITS.storyOverlay.recommended }));
  pack.messagingPillars.forEach((m, i) => run("messagingPillars", i, m, {}));

  const blocked = (field: FieldReport["field"], index: number) => fields.some((f) => f.field === field && f.index === index && !f.report.ok);
  const removed = fields.filter((f) => !f.report.ok);

  const cleaned: CopyPack = {
    ...pack,
    hooks: pack.hooks.filter((_, i) => !blocked("hook", i)),
    headlines: pack.headlines.filter((_, i) => !blocked("headline", i)),
    primaryTexts: pack.primaryTexts.filter((_, i) => !blocked("primaryText", i)),
    descriptions: pack.descriptions.filter((_, i) => !blocked("description", i)),
    storyOverlays: pack.storyOverlays.filter((_, i) => !blocked("storyOverlay", i)),
    messagingPillars: pack.messagingPillars.filter((_, i) => !blocked("messagingPillars", i)),
  };

  return { overall: mergeReports(fields.map((f) => f.report)), fields, cleaned, removed };
}

/** True when enough variants survived to build at least one ad per placement. */
export function hasMinimumViableCopy(pack: CopyPack): boolean {
  return pack.hooks.length >= 1 && pack.headlines.length >= 1 && pack.primaryTexts.length >= 1 && pack.descriptions.length >= 1 && pack.storyOverlays.length >= 1;
}

import type { BrandPalette, CampaignBrief } from "../../core/brief";
import { checkText, scoreIssues, type GuardrailIssue, type GuardrailReport } from "../../core/guardrails";
import { allowedFacts } from "../ideas/scoring";
import type { RenderedCreative } from "./types";

/**
 * Automated creative QA. These are the checks a designer does by eye; running
 * them in code means the review queue only contains creatives that are at
 * least legible, on-brand and safe for the placement.
 */

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export function textCoverage(rendered: RenderedCreative): number {
  const area = rendered.textBoxes.reduce((sum, b) => sum + Math.max(0, b.width) * Math.max(0, b.height), 0);
  return Math.round((area / (rendered.width * rendered.height)) * 1000) / 10;
}

export function checkCreative(rendered: RenderedCreative, palette: BrandPalette, brief: CampaignBrief): GuardrailReport {
  const issues: GuardrailIssue[] = [];
  const { spec } = rendered;

  const bg = palette[spec.colours.background];
  const text = palette[spec.colours.text];
  const ratio = contrastRatio(bg, text);
  if (ratio < 3) issues.push({ rule: "contrast.text", severity: "block", message: `Headline contrast ${ratio}:1 is below 3:1.` });
  else if (ratio < 4.5) issues.push({ rule: "contrast.text", severity: "warn", message: `Headline contrast ${ratio}:1 is below the 4.5:1 target.` });

  const ctaRatio = contrastRatio(palette[spec.colours.accent], palette.text);
  if (ctaRatio < 3) issues.push({ rule: "contrast.cta", severity: "warn", message: `CTA button contrast ${ctaRatio}:1 is low.` });

  const coverage = textCoverage(rendered);
  // Meta dropped the hard 20% text rule, but text-heavy images still under-deliver; these are performance heuristics.
  if (coverage > 50) issues.push({ rule: "text.coverage", severity: "block", message: `Text covers ${coverage}% of the image; too dense for paid social.` });
  else if (coverage > 35) issues.push({ rule: "text.coverage", severity: "warn", message: `Text covers ${coverage}% of the image; aim for under 35%.` });

  if (spec.format === "story") {
    const top = rendered.height * 0.14;
    const bottom = rendered.height * 0.8;
    for (const box of rendered.textBoxes) {
      if (box.y < top || box.y + box.height > bottom) {
        issues.push({ rule: "safezone.story", severity: "block", message: `${box.role} sits inside the Stories UI safe zone.` });
      }
    }
  }

  for (const box of rendered.textBoxes) {
    if (box.x + box.width > rendered.width + 1 || box.y + box.height > rendered.height + 1) {
      issues.push({ rule: "overflow", severity: "block", message: `${box.role} overflows the canvas.` });
    }
  }

  if (!rendered.textBoxes.some((b) => b.role === "cta")) issues.push({ rule: "cta.missing", severity: "block", message: "No CTA rendered." });
  if (!rendered.textBoxes.some((b) => b.role === "logo")) issues.push({ rule: "logo.missing", severity: "warn", message: "No logo lock-up rendered." });

  const headlineLines = rendered.textBoxes.find((b) => b.role === "headline");
  if (headlineLines && headlineLines.height > rendered.height * 0.4) {
    issues.push({ rule: "headline.lines", severity: "warn", message: "Headline wraps to too many lines for a glanceable ad." });
  }

  const textReport = checkText([spec.headline, spec.subline ?? "", spec.stat?.label ?? "", spec.badge ?? ""].filter(Boolean).join(". "), {
    allowedFacts: allowedFacts(brief),
    avoidWords: brief.client.voice.avoid,
  });
  issues.push(...textReport.issues);

  if (/\b(face|portrait|child|children)\b/i.test(spec.imagePrompt) && !/no (identifiable )?faces/i.test(spec.imagePrompt)) {
    issues.push({ rule: "image.consent", severity: "warn", message: "Image prompt may depict identifiable people; confirm consent or use a model release." });
  }

  return { ok: !issues.some((i) => i.severity === "block"), issues, score: scoreIssues(issues) };
}

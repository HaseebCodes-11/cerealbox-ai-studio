import type { CampaignBrief } from "../../core/brief";
import { checkText, scoreIssues, type GuardrailIssue, type GuardrailReport } from "../../core/guardrails";
import { allowedFacts } from "../ideas/scoring";
import type { LandingPageSpec } from "./types";

/**
 * Structural and compliance QA for a rendered landing page. These catch the
 * things that quietly kill conversion or breach fundraising rules: a missing
 * Gift Aid statement, amounts that do not match the ad, two H1s, no CTA in
 * the first screen, images without alt text, placeholder copy.
 */
export function checkLandingPage(spec: LandingPageSpec, html: string, brief: CampaignBrief): GuardrailReport {
  const issues: GuardrailIssue[] = [];

  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1Count !== 1) issues.push({ rule: "seo.h1", severity: "block", message: `Page has ${h1Count} H1 elements; exactly one required.` });

  if (!/<meta name="viewport"/.test(html)) issues.push({ rule: "mobile.viewport", severity: "block", message: "Missing viewport meta tag." });
  if (spec.title.length > 60) issues.push({ rule: "seo.title", severity: "warn", message: `Title is ${spec.title.length} chars; keep under 60.` });
  if (spec.metaDescription.length > 155) issues.push({ rule: "seo.description", severity: "warn", message: `Meta description is ${spec.metaDescription.length} chars; keep under 155.` });

  const heroEnd = html.indexOf("</section>");
  const firstCta = html.indexOf('data-cta="hero"');
  if (firstCta === -1 || (heroEnd !== -1 && firstCta > heroEnd)) issues.push({ rule: "cta.above-fold", severity: "block", message: "No CTA in the hero section." });

  const imgs = html.match(/<img\b[^>]*>/g) ?? [];
  for (const img of imgs) if (!/\balt="/.test(img)) issues.push({ rule: "a11y.alt", severity: "block", message: "Image without alt text." });
  const roleImgs = html.match(/role="img"[^>]*/g) ?? [];
  for (const r of roleImgs) if (!/aria-label="/.test(r)) issues.push({ rule: "a11y.alt", severity: "block", message: "Decorative image block without aria-label." });

  const tierAmounts = brief.offer.donationTiers.map((t) => t.amount).sort((a, b) => a - b);
  const formAmounts = [...spec.form.amounts].sort((a, b) => a - b);
  if (JSON.stringify(tierAmounts) !== JSON.stringify(formAmounts)) {
    issues.push({ rule: "form.amounts-match-offer", severity: "block", message: `Form amounts [${formAmounts.join(", ")}] do not match the offer tiers [${tierAmounts.join(", ")}].` });
  }
  if (!spec.form.amounts.includes(spec.form.defaultAmount)) issues.push({ rule: "form.default", severity: "block", message: "Default amount is not one of the offered amounts." });
  for (const i of spec.impact) if (!tierAmounts.includes(i.amount)) issues.push({ rule: "impact.amounts-match-offer", severity: "block", message: `Impact tier ${i.amount} is not an offer tier.` });

  if (brief.offer.giftAidEligible) {
    if (!spec.form.giftAid) issues.push({ rule: "giftaid.offered", severity: "block", message: "Gift Aid is not offered on the form." });
    if (!/Gift Aid/.test(html) || !/UK taxpayer/.test(html)) issues.push({ rule: "giftaid.declaration", severity: "block", message: "Gift Aid declaration wording missing." });
  }
  if (brief.client.charityNumber && !html.includes(brief.client.charityNumber)) issues.push({ rule: "compliance.charity-number", severity: "block", message: "Registered charity number not shown." });

  if (!/name="utm_source"/.test(html)) issues.push({ rule: "tracking.utm", severity: "warn", message: "UTM passthrough fields missing; attribution to the ad will be lost." });
  if (!/<form[^>]*method="post"/.test(html)) issues.push({ rule: "form.present", severity: "block", message: "No donation form found." });

  // Donation details must only ever post to the charity's own domain (or a relative handler).
  const clientHost = safeHost(brief.client.website);
  for (const form of html.match(/<form\b[^>]*>/g) ?? []) {
    const action = form.match(/\baction="([^"]*)"/)?.[1] ?? "";
    if (!/^https?:\/\//i.test(action)) continue;
    const host = safeHost(action);
    if (!host || !clientHost || !(host === clientHost || host.endsWith(`.${clientHost}`) || clientHost.endsWith(`.${host}`))) {
      issues.push({ rule: "form.action", severity: "block", message: `Donation form posts to ${host ?? action}, not the charity's domain.`, excerpt: action });
    }
  }

  const objections = brief.audience.objections.length;
  if (spec.faq.length < Math.min(objections, 2)) issues.push({ rule: "faq.coverage", severity: "warn", message: `FAQ has ${spec.faq.length} entries for ${objections} known objections.` });

  const allText = [
    spec.hero.headline,
    spec.hero.subheadline,
    spec.problem.body,
    spec.story.body,
    ...spec.impact.map((i) => i.label),
    ...spec.proof.map((p) => p.text),
    ...spec.faq.flatMap((f) => [f.question, f.answer]),
    spec.closingCta.headline,
  ].join("\n");
  const text = checkText(allText, { allowedFacts: [...allowedFacts(brief), "Gift Aid adds 25%", "past 4 years"], avoidWords: brief.client.voice.avoid, requireCta: true, maxReadingGrade: 9 });
  issues.push(...text.issues);

  if (/\[hero image\]/.test(html) === false) issues.push({ rule: "hero.image", severity: "info", message: "Hero has no image placeholder or asset." });

  return { ok: !issues.some((i) => i.severity === "block"), issues, score: scoreIssues(issues) };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Human-readable diff of what changed between variant A and B. */
export function variantDiff(a: LandingPageSpec, b: LandingPageSpec): string[] {
  const diffs: string[] = [];
  const compare = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${label}: "${String(x)}" -> "${String(y)}"`);
  };
  compare("hero.headline", a.hero.headline, b.hero.headline);
  compare("hero.subheadline", a.hero.subheadline, b.hero.subheadline);
  compare("hero.ctaLabel", a.hero.ctaLabel, b.hero.ctaLabel);
  compare("closingCta.headline", a.closingCta.headline, b.closingCta.headline);
  compare("form.defaultAmount", a.form.defaultAmount, b.form.defaultAmount);
  compare("form.amounts", a.form.amounts, b.form.amounts);
  return diffs;
}

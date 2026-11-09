import { readingGrade } from "./text";

/**
 * Deterministic quality controls that run on every piece of generated text
 * BEFORE a human sees it. They never replace human review; they make sure the
 * reviewer's time goes on judgement calls rather than catching typos, missing
 * CTAs or a model inventing a statistic.
 *
 * Severity:
 *  - "block": cannot ship; the pipeline regenerates or escalates.
 *  - "warn":  ships only if a human explicitly accepts it.
 *  - "info":  surfaced in the review UI, no action required.
 */
export type Severity = "block" | "warn" | "info";

export interface GuardrailIssue {
  rule: string;
  severity: Severity;
  message: string;
  excerpt?: string;
}

export interface GuardrailReport {
  ok: boolean;
  issues: GuardrailIssue[];
  score: number; // 0-100, 100 = no issues
}

/** Claims a charity cannot make without evidence, or that fundraising regulators dislike. */
const RISKY_CLAIM_PATTERNS: Array<{ pattern: RegExp; rule: string; severity: Severity; message: string }> = [
  { pattern: /\bguarantee[sd]?\b/i, rule: "claims.guarantee", severity: "block", message: "Outcome guarantees are not permitted in fundraising copy." },
  { pattern: /\b100% of (your )?(donation|gift|money)\b/i, rule: "claims.hundred-percent", severity: "warn", message: "'100% of your donation' needs documented evidence of a separately funded admin cost." },
  { pattern: /\bevery (single )?penny\b/i, rule: "claims.every-penny", severity: "warn", message: "'Every penny' implies zero overheads; verify or soften." },
  { pattern: /\bcure[sd]?\b/i, rule: "claims.cure", severity: "block", message: "Medical cure claims are not allowed." },
  { pattern: /\btax[- ]deductible\b/i, rule: "claims.tax-deductible", severity: "warn", message: "UK donors use Gift Aid; 'tax deductible' is US framing and may be inaccurate." },
  { pattern: /\b(you must|you have to|you are obliged)\b/i, rule: "pressure.obligation", severity: "warn", message: "Undue pressure language conflicts with the Fundraising Regulator code." },
  { pattern: /\b(will die|are dying) (without|unless) you\b/i, rule: "pressure.guilt", severity: "warn", message: "Direct guilt framing is high risk for brand trust; a human must sign off." },
  { pattern: /\b(first|only|best|biggest|largest) charity\b/i, rule: "claims.superlative", severity: "warn", message: "Superlatives need substantiation." },
];

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[[^\]]{1,40}\]/, // [INSERT NAME]
  /\{\{[^}]{1,40}\}\}/, // {{variable}}
  /\blorem ipsum\b/i,
  /\bTBD\b|\bTBC\b|\bTODO\b/,
  /\bINSERT\b/,
  /\bXX+\b|\bXXX\b/,
];

const PII_PATTERNS: Array<{ pattern: RegExp; rule: string; message: string }> = [
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, rule: "pii.email", message: "Email address in public copy." },
  { pattern: /(?<!\d)(?:\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}\b/, rule: "pii.phone", message: "UK mobile number in public copy." },
];

/** A statistic the model may have invented: a number with %/£/$ or 'people' that was not in the brief. */
const STAT_PATTERN = /(£|\$|€)\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s?%|\b\d[\d,]{2,}\b\s+(people|children|families|lives|meals|nights|hours)/gi;

export interface GuardrailOptions {
  /** Facts the copy is allowed to cite (proof points, tier impacts, match funding). */
  allowedFacts?: string[];
  /** Words or phrases the brand never uses. */
  avoidWords?: string[];
  /** Hard character limit for the field. */
  maxChars?: number;
  /** Recommended character limit (warn above). */
  recommendedChars?: number;
  /** Require a call to action verb somewhere in the text. */
  requireCta?: boolean;
  /** Maximum acceptable reading grade (default 9). */
  maxReadingGrade?: number;
  /** Treat unknown statistics as blockers rather than warnings. */
  strictFacts?: boolean;
}

const CTA_VERBS = /\b(donate|give|help|join|support|sponsor|sign up|start|learn more|find out|act now|make a gift|fund|protect|save|become|pledge|double)\b/i;

export function checkText(text: string, options: GuardrailOptions = {}): GuardrailReport {
  const issues: GuardrailIssue[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return { ok: false, issues: [{ rule: "empty", severity: "block", message: "Text is empty." }], score: 0 };
  }

  for (const rule of RISKY_CLAIM_PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (match) issues.push({ rule: rule.rule, severity: rule.severity, message: rule.message, excerpt: match[0] });
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) issues.push({ rule: "placeholder", severity: "block", message: "Unfilled placeholder text.", excerpt: match[0] });
  }

  for (const rule of PII_PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (match) issues.push({ rule: rule.rule, severity: "block", message: rule.message, excerpt: match[0] });
  }

  if (options.avoidWords?.length) {
    for (const word of options.avoidWords) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
      const match = trimmed.match(re);
      if (match) issues.push({ rule: "voice.avoid", severity: "warn", message: `Brand voice avoids "${word}".`, excerpt: match[0] });
    }
  }

  if (options.maxChars !== undefined && trimmed.length > options.maxChars) {
    issues.push({ rule: "length.max", severity: "block", message: `Text is ${trimmed.length} chars; hard limit is ${options.maxChars}.` });
  } else if (options.recommendedChars !== undefined && trimmed.length > options.recommendedChars) {
    issues.push({ rule: "length.recommended", severity: "warn", message: `Text is ${trimmed.length} chars; recommended max is ${options.recommendedChars} (will truncate in some placements).` });
  }

  if (options.requireCta && !CTA_VERBS.test(trimmed)) {
    issues.push({ rule: "cta.missing", severity: "warn", message: "No clear call to action." });
  }

  const grade = readingGrade(trimmed);
  const maxGrade = options.maxReadingGrade ?? 9;
  if (grade > maxGrade && trimmed.split(/\s+/).length >= 12) {
    issues.push({ rule: "readability", severity: "info", message: `Reading grade ${grade} is above the target of ${maxGrade}.` });
  }

  const stats = trimmed.match(STAT_PATTERN) ?? [];
  const allowed = (options.allowedFacts ?? []).join(" \n ").toLowerCase();
  // Numbers are compared without thousands separators so "4,200" matches "4200".
  const stripCommas = (s: string) => s.replace(/,(?=\d{3}\b)/g, "");
  const allowedNumbers = new Set(stripCommas(allowed).replace(/[^0-9.\s]/g, " ").split(/\s+/).filter(Boolean));
  for (const stat of stats) {
    const needle = stat.replace(/\s+/g, " ").trim().toLowerCase();
    const numeric = stripCommas(needle).replace(/[^0-9.]/g, "");
    const supported = allowed.includes(needle) || (numeric.length > 0 && allowedNumbers.has(numeric));
    if (!supported) {
      issues.push({
        rule: "facts.unverified",
        severity: options.strictFacts ? "block" : "warn",
        message: "Statistic not found in the brief's proof points; verify before publishing.",
        excerpt: stat,
      });
    }
  }

  const score = scoreIssues(issues);
  return { ok: !issues.some((i) => i.severity === "block"), issues, score };
}

export function scoreIssues(issues: GuardrailIssue[]): number {
  const penalty = issues.reduce((sum, i) => sum + (i.severity === "block" ? 40 : i.severity === "warn" ? 12 : 3), 0);
  return Math.max(0, 100 - penalty);
}

export function mergeReports(reports: GuardrailReport[]): GuardrailReport {
  const issues = reports.flatMap((r) => r.issues);
  return { ok: reports.every((r) => r.ok), issues, score: reports.length ? Math.round(reports.reduce((s, r) => s + r.score, 0) / reports.length) : 100 };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

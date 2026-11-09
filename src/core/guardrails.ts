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

/**
 * Claims a charity cannot make without evidence, or that fundraising regulators dislike.
 * Word gaps use \s+ so double spaces and line breaks cannot slip a claim past the check.
 */
const RISKY_CLAIM_PATTERNS: Array<{ pattern: RegExp; rule: string; severity: Severity; message: string }> = [
  { pattern: /\bguarantee[sd]?\b/i, rule: "claims.guarantee", severity: "block", message: "Outcome guarantees are not permitted in fundraising copy." },
  { pattern: /\b100%\s+of\s+(your\s+)?(donation|gift|money)\b/i, rule: "claims.hundred-percent", severity: "warn", message: "'100% of your donation' needs documented evidence of a separately funded admin cost." },
  { pattern: /\bevery\s+(single\s+)?penny\b/i, rule: "claims.every-penny", severity: "warn", message: "'Every penny' implies zero overheads; verify or soften." },
  { pattern: /\bcure[sd]?\b/i, rule: "claims.cure", severity: "block", message: "Medical cure claims are not allowed." },
  { pattern: /\btax[-\s]deductible\b/i, rule: "claims.tax-deductible", severity: "warn", message: "UK donors use Gift Aid; 'tax deductible' is US framing and may be inaccurate." },
  { pattern: /\b(you\s+must|you\s+have\s+to|you\s+are\s+obliged)\b/i, rule: "pressure.obligation", severity: "warn", message: "Undue pressure language conflicts with the Fundraising Regulator code." },
  { pattern: /\b(will\s+die|are\s+dying)\s+(without|unless)\s+you\b/i, rule: "pressure.guilt", severity: "warn", message: "Direct guilt framing is high risk for brand trust; a human must sign off." },
  { pattern: /\b(first|only|best|biggest|largest)\s+charity\b/i, rule: "claims.superlative", severity: "warn", message: "Superlatives need substantiation." },
];

/** "We cannot guarantee…" is a hedge, not a promise: still worth a reviewer's eye, never a hard block. */
const NEGATED_GUARANTEE = /\b(cannot|can't|can\s+not|don't|do\s+not|never|no|without)\s+(any\s+)?guarantee/i;

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{[^}]{1,40}\}\}/, // {{variable}}
  /\{[a-z_][a-z0-9_ ]{0,39}\}/i, // {first_name}
  /\blorem\s+ipsum\b/i,
  /\bTBD\b|\bTBC\b|\bTODO\b/,
  /\bINSERT\b/,
  /\bXX+\b/,
  /\b(goes|go)\s+here\b/i, // "headline goes here"
  /\b(your|insert)\s+(text|copy|headline|name)\s+here\b/i,
];

/**
 * Square-bracket placeholders ([CHARITY NAME]) versus stage directions ([music swells]):
 * flag when the content is shouting or names a thing to fill in.
 */
const BRACKET_PATTERN = /\[([^\]]{1,40})\]/g;
const BRACKET_SHOUTING = /^[A-Z0-9 _\-\/.]+$/; // case-sensitive on purpose
const BRACKET_KEYWORDS = /\b(insert|placeholder|name|charity|client|tbd|todo|headline|copy here)\b/i;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Candidate UK phone numbers: start with 0 or +44, then 10-11 digits with optional spacing. Validated by digit count. */
const PHONE_CANDIDATE = /(?:\+44[\s-]?\(?0?\)?[\s-]?|(?<!\d)0)[\d\s\-()]{8,16}\d/g;

/**
 * A statistic the model may have invented. Several shapes:
 *  money (£30), percentages (97%), N people/children/..., k/m/bn shorthand (4k, 1.2m),
 *  ratios ("9 in 10", "nine in ten"), and any number of three or more digits.
 */
const STAT_PATTERNS: RegExp[] = [
  /(£|\$|€)\s?\d[\d,]*(\.\d+)?(\s?(k|m|bn|million|thousand|billion))?/gi,
  /\b\d[\d,]*(\.\d+)?\s?%/g,
  /\b\d[\d,]*(\.\d+)?\s?(k|m|bn|million|thousand|billion)\b/gi,
  /\b\d[\d,]*(\.\d+)?\s+(people|children|families|lives|meals|nights|hours|towns|homes|households|donors|schools|visits)\b/gi,
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+in\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
  /\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b/g,
];

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

export interface GuardrailOptions {
  /** Facts the copy is allowed to cite (proof points, tier impacts, match funding). */
  allowedFacts?: string[];
  /** Words or phrases the brand never uses. */
  avoidWords?: string[];
  /** Hard character limit for the field (non-positive = no limit). */
  maxChars?: number;
  /** Recommended character limit (warn above; non-positive = no limit). */
  recommendedChars?: number;
  /** Require a call to action verb somewhere in the text. */
  requireCta?: boolean;
  /** Maximum acceptable reading grade (default 9). */
  maxReadingGrade?: number;
  /** Treat unknown statistics as blockers rather than warnings. */
  strictFacts?: boolean;
}

const CTA_VERBS = /\b(donate|give|help|join|support|sponsor|sign up|start|learn more|find out|act now|make a gift|fund|protect|save|become|pledge|double)\b/i;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Length as a person counts it: one emoji is one character. */
export function graphemeLength(text: string): number {
  if (!segmenter) return [...text].length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export function checkText(text: string, options: GuardrailOptions = {}): GuardrailReport {
  const issues: GuardrailIssue[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return { ok: false, issues: [{ rule: "empty", severity: "block", message: "Text is empty." }], score: 0 };
  }

  for (const rule of RISKY_CLAIM_PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    if (rule.rule === "claims.guarantee" && NEGATED_GUARANTEE.test(trimmed)) {
      issues.push({ rule: rule.rule, severity: "warn", message: "Hedged guarantee language; a reviewer should confirm it reads as honest, not evasive.", excerpt: match[0] });
      continue;
    }
    issues.push({ rule: rule.rule, severity: rule.severity, message: rule.message, excerpt: match[0] });
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) issues.push({ rule: "placeholder", severity: "block", message: "Unfilled placeholder text.", excerpt: match[0] });
  }
  for (const match of trimmed.matchAll(BRACKET_PATTERN)) {
    const inner = match[1] ?? "";
    if (BRACKET_SHOUTING.test(inner) || BRACKET_KEYWORDS.test(inner)) issues.push({ rule: "placeholder", severity: "block", message: "Unfilled placeholder text.", excerpt: match[0] });
  }

  const email = trimmed.match(EMAIL_PATTERN);
  if (email) issues.push({ rule: "pii.email", severity: "block", message: "Email address in public copy.", excerpt: email[0] });
  for (const candidate of trimmed.matchAll(PHONE_CANDIDATE)) {
    const digits = candidate[0].replace(/\D/g, "");
    const national = digits.startsWith("44") ? `0${digits.slice(2).replace(/^0/, "")}` : digits;
    if (national.length >= 10 && national.length <= 11 && /^0[1-9]/.test(national)) {
      issues.push({ rule: "pii.phone", severity: "block", message: "UK phone number in public copy.", excerpt: candidate[0].trim() });
    }
  }

  if (options.avoidWords?.length) {
    for (const word of options.avoidWords) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
      const match = trimmed.match(re);
      if (match) issues.push({ rule: "voice.avoid", severity: "warn", message: `Brand voice avoids "${word}".`, excerpt: match[0] });
    }
  }

  const length = graphemeLength(trimmed);
  const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : undefined;
  const recommendedChars = options.recommendedChars && options.recommendedChars > 0 ? options.recommendedChars : undefined;
  if (maxChars !== undefined && length > maxChars) {
    issues.push({ rule: "length.max", severity: "block", message: `Text is ${length} chars; hard limit is ${maxChars}.` });
  } else if (recommendedChars !== undefined && length > recommendedChars) {
    issues.push({ rule: "length.recommended", severity: "warn", message: `Text is ${length} chars; recommended max is ${recommendedChars} (will truncate in some placements).` });
  }

  if (options.requireCta && !CTA_VERBS.test(trimmed)) {
    issues.push({ rule: "cta.missing", severity: "warn", message: "No clear call to action." });
  }

  const grade = readingGrade(trimmed);
  const maxGrade = options.maxReadingGrade ?? 9;
  if (grade > maxGrade && trimmed.split(/\s+/).length >= 12) {
    issues.push({ rule: "readability", severity: "info", message: `Reading grade ${grade} is above the target of ${maxGrade}.` });
  }

  // Statistics: strip URLs, ISO dates and clock times first so their digits are not mistaken for claims.
  const statText = trimmed
    .replace(/https?:\/\/\S+|\b[\w.-]+\.(?:org|com|co\.uk|net|io|uk)\b\/?\S*/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, " ");
  const allowed = (options.allowedFacts ?? []).join(" \n ").toLowerCase();
  const stripCommas = (s: string) => s.replace(/,(?=\d{3}\b)/g, "");
  // Compare numerically so 2.50 matches 2.5 and 1,000,000 matches 1000000.
  const canonical = (n: string) => (Number.isFinite(Number(n)) ? String(Number(n)) : n);
  const allowedNumbers = new Set(stripCommas(allowed).replace(/[^0-9.\s]/g, " ").split(/\s+/).filter(Boolean).map(canonical));
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];
  for (const pattern of STAT_PATTERNS) {
    for (const match of statText.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      // A later, looser pattern must not re-report digits already covered by an earlier match (e.g. "999" inside "£999").
      if (spans.some(([s, e]) => start < e && s < end)) continue;
      spans.push([start, end]);
      const stat = match[0].trim();
      const needle = stat.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(needle)) continue;
      seen.add(needle);
      const normalised = needle.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => NUMBER_WORDS[w] ?? w);
      const numeric = stripCommas(normalised).replace(/[^0-9.]/g, "");
      const ratio = normalised.match(/^(\d+)\s+in\s+(\d+)$/);
      const supported =
        allowed.includes(needle) ||
        allowed.includes(normalised) ||
        (ratio ? allowed.includes(`${ratio[1]} in ${ratio[2]}`) : false) ||
        (numeric.length > 0 && allowedNumbers.has(canonical(numeric)) && !/(k|m|bn|million|thousand|billion)$/i.test(normalised));
      if (!supported) {
        issues.push({
          rule: "facts.unverified",
          severity: options.strictFacts ? "block" : "warn",
          message: "Statistic not found in the brief's proof points; verify before publishing.",
          excerpt: stat,
        });
      }
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

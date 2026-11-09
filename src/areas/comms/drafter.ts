import type { AdsDataset } from "../../core/ads";
import { checkText } from "../../core/guardrails";
import { defineTask, type LLMProvider } from "../../core/llm/provider";
import type { Recommendation } from "../media-buyer/types";
import { aggregate, comparePeriods, lastNDays } from "../toast/metrics";
import { numbersIn } from "../reporting/report";
import { ClientReplySchema, type ClientQuestion, type ClientReply, type CommsContext, type CommsDraft, type QuestionCategory } from "./types";

const CLIENT_SAFE: Record<Recommendation["type"], string> = {
  pause_ad: "retiring an ad that was not bringing in donations",
  pause_adset: "pausing an audience that is not delivering value",
  increase_budget: "increasing budget on an audience that is beating target",
  decrease_budget: "trimming budget where the cost per donation has risen",
  refresh_creative: "refreshing a creative that has been seen too often",
  investigate_tracking: "checking a possible tracking issue with your donation platform",
  exit_learning_limited: "consolidating audiences so Meta can optimise properly",
  notify: "monitoring",
};

export function buildCommsContext(data: AdsDataset, recommendations: Recommendation[], clientId: string, asOf: string, options: { contactFirstName: string; accountManager: string; days?: number; reportUrl?: string }): CommsContext {
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client ${clientId}`);
  const days = options.days ?? 7;
  const cmp = comparePeriods(data, "client", asOf, days).find((c) => c.clientId === clientId);
  const period = lastNDays(asOf, days);
  const ads = aggregate(data, "ad", period, { clientId }).filter((a) => a.spend >= 50 && a.conversions >= 3).sort((a, b) => b.roas - a.roas);
  const adById = new Map(data.ads.map((a) => [a.id, a]));
  const best = ads[0];
  const budget = data.adsets.filter((a) => a.clientId === clientId && a.status === "ACTIVE").reduce((s, a) => s + a.dailyBudgetGbp, 0);
  return {
    clientName: client.name,
    contactFirstName: options.contactFirstName,
    accountManager: options.accountManager,
    asOf,
    days,
    figures: {
      spend: cmp?.recent.spend ?? 0,
      revenue: cmp?.recent.revenue ?? 0,
      roas: cmp?.recent.roas ?? 0,
      targetRoas: client.targetRoas,
      conversions: cmp?.recent.conversions ?? 0,
      cpa: cmp?.recent.cpa ?? 0,
      avgGift: cmp?.recent.avgGift ?? 0,
    },
    deltasPct: { revenue: cmp?.deltas.revenue ?? 0, roas: cmp?.deltas.roas ?? 0, cpa: cmp?.deltas.cpa ?? 0, spend: cmp?.deltas.spend ?? 0 },
    dailyBudgetGbp: budget,
    topCreative: best ? { name: best.name, type: adById.get(best.key)?.creativeType ?? "unknown", roas: best.roas } : null,
    openActions: [...new Set(recommendations.filter((r) => r.entity.clientId === clientId && r.status === "proposed").map((r) => CLIENT_SAFE[r.type]))],
    ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}),
  };
}

export interface ReplyInput {
  question: ClientQuestion;
  context: CommsContext;
}

const SYSTEM = `You draft replies from a charity's paid-media agency to a client's email. A human account manager will read and send it; you never send.
Rules:
- Use only the figures in the context. If the question needs information you do not have (invoices, contracts, legal, anything upsetting or a complaint), do not guess: set needsHumanInput=true, give the reason, and draft only a short holding reply.
- Plain English for a fundraising director: "audience" not "ad set", "cost per donation" not "CPA", "return" not "ROAS".
- Never promise results. Never mention internal tools, rules or model names.
- Warm, brief, specific. Sign off as the account manager.`;

export const clientReplyTask = defineTask<ReplyInput, ClientReply>({
  name: "comms.clientReply",
  description: "Draft a reply to a client question using only real figures",
  schema: ClientReplySchema,
  system: SYSTEM,
  effort: "low",
  prompt: ({ question, context }) =>
    [
      `Client: ${context.clientName}. Contact: ${context.contactFirstName}. Account manager: ${context.accountManager}.`,
      `Latest ${context.days} days to ${context.asOf}: spend £${context.figures.spend}, raised £${context.figures.revenue}, return ${context.figures.roas}x (target ${context.figures.targetRoas}x), ${context.figures.conversions} donations at £${context.figures.cpa} each, average gift £${context.figures.avgGift}. Changes vs previous period: raised ${context.deltasPct.revenue}%, return ${context.deltasPct.roas}%, cost per donation ${context.deltasPct.cpa}%. Daily budget £${context.dailyBudgetGbp}.`,
      context.topCreative ? `Best creative: ${context.topCreative.name} (${context.topCreative.type}) at ${context.topCreative.roas}x.` : "",
      context.openActions.length ? `What we are doing this week: ${context.openActions.join("; ")}.` : "",
      context.reportUrl ? `Full report: ${context.reportUrl}` : "",
      `Client email from ${question.from} on ${question.receivedAt}:\n"""${question.text}"""`,
    ]
      .filter(Boolean)
      .join("\n"),
  mock: ({ question, context }) => mockReply(question, context),
});

export function categorise(text: string): QuestionCategory {
  const q = text.toLowerCase();
  // Order matters: anything a human must own (money disputes, upset clients) wins over data questions.
  if (/\b(invoice|invoices|bill|billing|payment terms|fees?|charged|refund)\b/.test(q)) return "billing";
  if (/\b(unhappy|disappointed|complain|complaint|unacceptable|angry|furious|cancel)\b/.test(q)) return "complaint";
  if (/\b(budget|spend more|spend less|spending more|spending less|increase|decrease|how much are we spending|daily spend)\b/.test(q)) return "budget";
  if (/\b(creative|creatives|video|image|copy|design|which ad|ad is working|ads? look)\b/.test(q)) return "creative";
  if (/\b(how (are|is) .{0,40}(doing|performing|going)|results|roas|return|performance|cost per)\b/.test(q)) return "performance";
  if (/\b(report|dashboard|board pack|numbers for the board|summary of the numbers|summary)\b/.test(q)) return "reporting";
  if (/\bdonations?\b/.test(q)) return "performance";
  return "other";
}

export function mockReply(question: ClientQuestion, ctx: CommsContext): ClientReply {
  const category = categorise(question.text);
  const f = ctx.figures;
  const hi = `Hi ${ctx.contactFirstName},`;
  const signoff = `\n\nBest wishes,\n${ctx.accountManager}`;
  const money = (n: number) => `£${Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
  const onTarget = f.roas >= f.targetRoas;

  switch (category) {
    case "performance":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nGood question. Over the last ${ctx.days} days your campaigns raised ${money(f.revenue)} from ${f.conversions} donations on ${money(f.spend)} of advertising, a return of ${f.roas}x against the ${f.targetRoas}x we agreed. That is ${onTarget ? "ahead of" : "below"} target, and the amount raised is ${ctx.deltasPct.revenue >= 0 ? "up" : "down"} ${Math.abs(ctx.deltasPct.revenue)}% on the previous period.${ctx.topCreative ? ` The strongest ad is "${ctx.topCreative.name}" at ${ctx.topCreative.roas}x.` : ""}${ctx.openActions.length ? `\n\nThis week we are ${ctx.openActions.slice(0, 2).join(" and ")}.` : ""}${ctx.reportUrl ? `\n\nThe full weekly report is here: ${ctx.reportUrl}` : ""}${signoff}`,
        factsUsed: [`revenue £${f.revenue}`, `donations ${f.conversions}`, `spend £${f.spend}`, `roas ${f.roas}`, `target ${f.targetRoas}`, `revenue delta ${ctx.deltasPct.revenue}%`],
        needsHumanInput: false,
        confidence: 0.85,
      };
    case "budget":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nThe account is currently set to ${money(ctx.dailyBudgetGbp)} a day across your audiences, and over the last ${ctx.days} days we spent ${money(f.spend)} to raise ${money(f.revenue)} (${f.roas}x). ${onTarget ? `Because we are ahead of the ${f.targetRoas}x target, there is room to increase in measured steps, and I would suggest we do that on the audience that is performing best rather than everywhere at once.` : `Because the return is currently ${f.roas}x against a ${f.targetRoas}x target, I would hold the budget where it is while we improve the creative and audiences, then scale once we are back on target.`} Happy to talk through options on a quick call this week.${signoff}`,
        factsUsed: [`daily budget £${ctx.dailyBudgetGbp}`, `spend £${f.spend}`, `revenue £${f.revenue}`, `roas ${f.roas}`],
        needsHumanInput: false,
        confidence: 0.8,
      };
    case "creative":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\n${ctx.topCreative ? `The ad working hardest right now is "${ctx.topCreative.name}", a ${ctx.topCreative.type} creative returning ${ctx.topCreative.roas}x.` : `We are still gathering enough data to call a clear winner among the current creatives.`}${ctx.openActions.some((a) => /creative/.test(a)) ? ` One of the older ads has been seen too often by the same people, so a fresh version is in production and I will share it for your approval before it goes live.` : ""} If there is a message or image you would like us to test, send it over and we will build it into the next round.${signoff}`,
        factsUsed: ctx.topCreative ? [`top creative ${ctx.topCreative.name} ${ctx.topCreative.roas}x`] : [],
        needsHumanInput: false,
        confidence: 0.75,
      };
    case "reporting":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nOf course. The headline for the ${ctx.days} days to ${ctx.asOf}: ${money(f.revenue)} raised from ${f.conversions} donations, a ${f.roas}x return on ${money(f.spend)} spend, average gift ${money(f.avgGift)}.${ctx.reportUrl ? ` The full report with the breakdown by audience is here: ${ctx.reportUrl}.` : " I will send the full report with the breakdown by audience shortly."} If the trustees would like a particular cut of the numbers, tell me what they need and I will add it.${signoff}`,
        factsUsed: [`revenue £${f.revenue}`, `donations ${f.conversions}`, `roas ${f.roas}`, `spend £${f.spend}`, `avg gift £${f.avgGift}`],
        needsHumanInput: false,
        confidence: 0.85,
      };
    case "billing":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nThanks for flagging this. I am checking the details with our finance team and will come back to you with a full answer by the end of tomorrow.${signoff}`,
        factsUsed: [],
        needsHumanInput: true,
        escalationReason: "Billing and invoice questions need finance; the assistant has no access to invoices.",
        confidence: 0.95,
      };
    case "complaint":
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nI am sorry this has been frustrating. I want to understand exactly what has gone wrong and put it right, so I will call you today rather than go back and forth by email.${signoff}`,
        factsUsed: [],
        needsHumanInput: true,
        escalationReason: "Complaints are handled personally by the account manager; no automated reply beyond a holding note.",
        confidence: 0.95,
      };
    default:
      return {
        category,
        subject: `Re: ${truncateSubject(question.text)}`,
        reply: `${hi}\n\nThanks for your email. I want to give you a proper answer rather than a quick one, so let me look into this and come back to you shortly.${signoff}`,
        factsUsed: [],
        needsHumanInput: true,
        escalationReason: "Question does not match a data-backed category; a human needs to answer.",
        confidence: 0.6,
      };
  }
}

/** Draft, then verify: guardrails on tone/claims and a strict check that every number came from the context. */
export async function draftClientReply(question: ClientQuestion, context: CommsContext, provider: LLMProvider): Promise<CommsDraft> {
  const result = await provider.run(clientReplyTask, { question, context });
  const reply = result.output;
  const facts = contextNumbers(context);
  const report = checkText(reply.reply, { allowedFacts: facts, requireCta: false, maxReadingGrade: 10 });
  const issues = report.issues.filter((i) => i.rule !== "facts.unverified").map((i) => `${i.severity}: ${i.rule} ${i.excerpt ?? ""}`.trim());
  const found = numbersIn(reply.reply);
  const allowed = new Set(facts.flatMap((f) => numbersIn(f)));
  const unverified = [...new Set(found.filter((n) => !allowed.has(n)))];
  const risk: CommsDraft["risk"] = reply.needsHumanInput || !report.ok || unverified.length > 0 || reply.confidence < 0.7 ? "human" : "approve";
  return { question, reply, guardrails: { ok: report.ok, issues }, numbers: { ok: unverified.length === 0, unverified }, risk };
}

export function contextNumbers(ctx: CommsContext): string[] {
  const f = ctx.figures;
  return [
    `£${f.spend}`,
    `£${f.revenue}`,
    `${f.roas}x`,
    `${f.targetRoas}x`,
    `${f.conversions} donations`,
    `£${f.cpa}`,
    `£${f.avgGift}`,
    `${ctx.deltasPct.revenue}%`,
    `${ctx.deltasPct.roas}%`,
    `${ctx.deltasPct.cpa}%`,
    `${ctx.deltasPct.spend}%`,
    `£${ctx.dailyBudgetGbp}`,
    `${ctx.days} days`,
    ctx.asOf,
    ctx.topCreative ? `${ctx.topCreative.name} ${ctx.topCreative.roas}x` : "",
    ...ctx.openActions,
    ctx.reportUrl ?? "",
    // Spelled-out small quantities in holding replies ("end of tomorrow", "one of the older ads") carry no digits.
  ].filter(Boolean);
}

export function draftsToMarkdown(drafts: CommsDraft[]): string {
  return drafts
    .map((d) =>
      [
        `## ${d.question.clientId} · ${d.question.from} · ${d.question.receivedAt}`,
        ``,
        `> ${d.question.text}`,
        ``,
        `**${d.reply.subject}** · category ${d.reply.category} · risk **${d.risk}** · confidence ${Math.round(d.reply.confidence * 100)}%${d.reply.needsHumanInput ? ` · escalate: ${d.reply.escalationReason}` : ""}`,
        ``,
        "```",
        d.reply.reply,
        "```",
        ``,
        `Numbers verified: ${d.numbers.ok ? "yes" : `no (${d.numbers.unverified.join(", ")})`} · Guardrails: ${d.guardrails.ok ? "clean" : d.guardrails.issues.join("; ")}`,
        ``,
      ].join("\n"),
    )
    .join("\n");
}

function truncateSubject(text: string): string {
  const first = text.split(/[.?!\n]/)[0]?.trim() ?? text;
  return first.length > 70 ? `${first.slice(0, 69)}…` : first;
}

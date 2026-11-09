import { z } from "zod";

/**
 * Client communications: AI drafts replies to common client questions from
 * real data; a human always approves before anything is sent. Questions the
 * model cannot answer from data (billing, contracts, complaints, anything
 * emotional) are escalated with a reason instead of guessed.
 */
export const QUESTION_CATEGORIES = ["performance", "budget", "creative", "reporting", "billing", "complaint", "other"] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const ClientReplySchema = z.object({
  category: z.enum(QUESTION_CATEGORIES),
  subject: z.string().min(3).max(120),
  reply: z.string().min(20),
  factsUsed: z.array(z.string()).default([]),
  needsHumanInput: z.boolean(),
  escalationReason: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export type ClientReply = z.infer<typeof ClientReplySchema>;

export interface CommsContext {
  clientName: string;
  contactFirstName: string;
  accountManager: string;
  asOf: string;
  days: number;
  figures: { spend: number; revenue: number; roas: number; targetRoas: number; conversions: number; cpa: number; avgGift: number };
  deltasPct: { revenue: number; roas: number; cpa: number; spend: number };
  dailyBudgetGbp: number;
  topCreative: { name: string; type: string; roas: number } | null;
  openActions: string[];
  reportUrl?: string;
}

export interface ClientQuestion {
  id: string;
  clientId: string;
  from: string;
  receivedAt: string;
  text: string;
}

export interface CommsDraft {
  question: ClientQuestion;
  reply: ClientReply;
  guardrails: { ok: boolean; issues: string[] };
  numbers: { ok: boolean; unverified: string[] };
  /** approve = one-click send after a human glance; human = someone must write or decide. */
  risk: "approve" | "human";
}

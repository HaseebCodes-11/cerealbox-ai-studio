import { z } from "zod";

/**
 * Client-facing reporting. The report input is computed by code; the model
 * only writes the words. A number verifier then proves every figure in the
 * narrative exists in the input, so a client never reads an invented number.
 */
export const ClientReportNarrativeSchema = z.object({
  headline: z.string().min(5).max(120),
  summary: z.array(z.string().min(20)).min(1).max(3),
  highlights: z.array(z.string().min(5)).max(5),
  concerns: z.array(z.string().min(5)).max(4),
  nextSteps: z.array(z.string().min(5)).min(1).max(4),
});
export type ClientReportNarrative = z.infer<typeof ClientReportNarrativeSchema>;

export interface ReportFigures {
  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  cpa: number;
  avgGift: number;
}

export interface ClientReportInput {
  clientId: string;
  clientName: string;
  asOf: string;
  days: number;
  targetRoas: number;
  current: ReportFigures;
  previous: ReportFigures;
  deltasPct: { spend: number; revenue: number; roas: number; conversions: number; cpa: number };
  adsets: Array<{ name: string; spend: number; revenue: number; roas: number; conversions: number }>;
  topCreative: { name: string; type: string; roas: number } | null;
  insights: Array<{ severity: string; title: string; detail: string }>;
  /** Internal recommendations translated to client-safe language by code, not the model. */
  actions: string[];
}

export interface NumberCheck {
  ok: boolean;
  unverified: string[];
  checked: number;
}

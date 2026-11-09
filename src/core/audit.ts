import type { LLMUsage } from "./llm/provider";

/**
 * Append-only log of what the system did: every model call, every guardrail
 * result, every review decision and every action taken on an ad account.
 * In production this is a Postgres table (see supabase/migrations) and feeds
 * the cost dashboard and the "why did the agent do that?" view.
 */
export type AuditEventType = "llm_call" | "guardrail" | "review" | "action" | "render" | "note" | "error";

export interface AuditEvent {
  seq: number;
  at: string;
  type: AuditEventType;
  area: string;
  step: string;
  detail: Record<string, unknown>;
  usage?: LLMUsage;
}

export class AuditLog {
  private readonly events: AuditEvent[] = [];
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  record(type: AuditEventType, area: string, step: string, detail: Record<string, unknown> = {}, usage?: LLMUsage): AuditEvent {
    const event: AuditEvent = {
      seq: this.events.length + 1,
      at: this.clock().toISOString(),
      type,
      area,
      step,
      detail,
      ...(usage ? { usage } : {}),
    };
    this.events.push(event);
    return event;
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }

  byType(type: AuditEventType): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  totals(): { llmCalls: number; inputTokens: number; outputTokens: number; costUsd: number; byArea: Record<string, number> } {
    const byArea: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let llmCalls = 0;
    for (const e of this.events) {
      if (e.type === "llm_call" && e.usage) {
        llmCalls++;
        inputTokens += e.usage.inputTokens;
        outputTokens += e.usage.outputTokens;
        costUsd += e.usage.costUsd;
        byArea[e.area] = (byArea[e.area] ?? 0) + e.usage.costUsd;
      }
    }
    return { llmCalls, inputTokens, outputTokens, costUsd, byArea };
  }

  toJSON(): AuditEvent[] {
    return [...this.events];
  }
}

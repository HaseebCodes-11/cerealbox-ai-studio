/**
 * Human-in-the-loop primitives.
 *
 * Every workflow has explicit review gates. A gate takes an artefact plus the
 * automated guardrail result and asks a Reviewer to approve, reject or edit.
 * In production the Reviewer is a Supabase table + a React approval screen
 * (or a Slack approval message); in tests and demos it is a policy object.
 */
import type { GuardrailReport } from "./guardrails";

export type RiskTier = "auto" | "approve" | "human";

export interface ReviewRequest<T> {
  gate: string;
  area: string;
  artefact: T;
  guardrails?: GuardrailReport;
  risk: RiskTier;
  summary: string;
}

export type ReviewDecision<T> =
  | { status: "approved"; artefact: T; reviewer: string; note?: string }
  | { status: "rejected"; reviewer: string; reason: string }
  | { status: "pending"; reviewer?: undefined; reason?: string };

export interface Reviewer {
  readonly name: string;
  review<T>(request: ReviewRequest<T>): Promise<ReviewDecision<T>>;
}

/**
 * Demo/test policy: approves anything the guardrails did not block, and auto
 * approves "auto"-tier items. Anything blocked is rejected with the reasons.
 */
export class PolicyReviewer implements Reviewer {
  readonly name: string;
  constructor(options: { name?: string; approveWarnings?: boolean } = {}) {
    this.name = options.name ?? "policy-reviewer";
    this.approveWarnings = options.approveWarnings ?? true;
  }
  private readonly approveWarnings: boolean;

  async review<T>(request: ReviewRequest<T>): Promise<ReviewDecision<T>> {
    const report = request.guardrails;
    if (report && !report.ok) {
      const blockers = report.issues.filter((i) => i.severity === "block").map((i) => `${i.rule}: ${i.message}`);
      return { status: "rejected", reviewer: this.name, reason: blockers.join("; ") };
    }
    if (request.risk === "human" && report && report.issues.some((i) => i.severity === "warn") && !this.approveWarnings) {
      return { status: "pending", reason: "Warnings require a named human reviewer." };
    }
    return { status: "approved", artefact: request.artefact, reviewer: this.name };
  }
}

/** Records every request so the demo and tests can show what humans were asked. */
export class RecordingReviewer implements Reviewer {
  readonly name: string;
  readonly requests: ReviewRequest<unknown>[] = [];
  private readonly inner: Reviewer;
  constructor(inner: Reviewer = new PolicyReviewer()) {
    this.inner = inner;
    this.name = `recording(${inner.name})`;
  }
  async review<T>(request: ReviewRequest<T>): Promise<ReviewDecision<T>> {
    this.requests.push(request as ReviewRequest<unknown>);
    return this.inner.review(request);
  }
}

/** Always leaves items pending - used to prove pipelines stop at gates. */
export class PendingReviewer implements Reviewer {
  readonly name = "pending-reviewer";
  async review<T>(_request: ReviewRequest<T>): Promise<ReviewDecision<T>> {
    return { status: "pending", reason: "Awaiting human review." };
  }
}

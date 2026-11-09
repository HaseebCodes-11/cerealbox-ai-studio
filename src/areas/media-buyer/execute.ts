/**
 * Builds the Meta Marketing API write for an approved recommendation.
 *
 * Pure and strict on purpose: the Edge Function that executes approvals
 * reads the proposed change back from the database, and a malformed or
 * tampered row must never become a request to a live ad account. Everything
 * here is validated before a URL or body is produced.
 */
export type MetaExecutionField = "daily_budget_gbp" | "status";

export interface ExecutableChange {
  field: string;
  to: string | number;
}

export interface MetaExecutionRequest {
  url: string;
  /** Form fields for the POST body (the access token is added by the caller). */
  body: Record<string, string>;
  /** Human-readable description for the action log. */
  detail: string;
}

export const META_GRAPH_VERSION = "v21.0";
const META_ID = /^\d{5,24}$/;
const STATUSES = new Set(["ACTIVE", "PAUSED", "ARCHIVED"]);
/** Pence. £1 minimum (Meta's own floor is higher for most currencies), £100k/day ceiling as a sanity stop. */
export const MIN_DAILY_BUDGET_GBP = 1;
export const MAX_DAILY_BUDGET_GBP = 100_000;

export class MetaExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaExecutionError";
  }
}

export function buildMetaExecutionRequest(entityLevel: string, entityId: unknown, change: ExecutableChange | null | undefined): MetaExecutionRequest {
  if (!change || typeof change !== "object") throw new MetaExecutionError("nothing to execute for this recommendation");
  if (typeof entityId !== "string" || !META_ID.test(entityId)) throw new MetaExecutionError("entity id is not a Meta object id");
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(entityId)}`;

  switch (change.field) {
    case "daily_budget_gbp": {
      const gbp = typeof change.to === "number" ? change.to : Number(String(change.to).trim());
      if (!Number.isFinite(gbp) || gbp < MIN_DAILY_BUDGET_GBP || gbp > MAX_DAILY_BUDGET_GBP) {
        throw new MetaExecutionError(`daily budget must be a number between ${MIN_DAILY_BUDGET_GBP} and ${MAX_DAILY_BUDGET_GBP} GBP`);
      }
      const pence = Math.round(gbp * 100);
      return { url, body: { daily_budget: String(pence) }, detail: `${entityLevel} ${entityId}: daily_budget_gbp -> ${gbp}` };
    }
    case "status": {
      const status = String(change.to).trim().toUpperCase();
      if (!STATUSES.has(status)) throw new MetaExecutionError(`status must be one of ${[...STATUSES].join(", ")}`);
      return { url, body: { status }, detail: `${entityLevel} ${entityId}: status -> ${status}` };
    }
    default:
      throw new MetaExecutionError(`field "${String(change.field)}" cannot be executed`);
  }
}

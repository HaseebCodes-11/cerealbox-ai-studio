import { describe, expect, it } from "vitest";
import { buildMetaExecutionRequest, MAX_DAILY_BUDGET_GBP, MetaExecutionError, META_GRAPH_VERSION } from "../../src/areas/media-buyer";

describe("buildMetaExecutionRequest (SEC-03)", () => {
  it("builds a budget change in pence against the pinned Graph version", () => {
    const r = buildMetaExecutionRequest("adset", "23851234567890123", { field: "daily_budget_gbp", to: 42.5 });
    expect(r.url).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/23851234567890123`);
    expect(r.body).toEqual({ daily_budget: "4250" });
    expect(r.detail).toBe("adset 23851234567890123: daily_budget_gbp -> 42.5");
  });

  it("accepts a numeric string budget (as stored in JSON) and rounds to whole pence", () => {
    expect(buildMetaExecutionRequest("adset", "123456789", { field: "daily_budget_gbp", to: "19.999" }).body).toEqual({ daily_budget: "2000" });
  });

  it("normalises and whitelists status values", () => {
    expect(buildMetaExecutionRequest("ad", "123456789", { field: "status", to: "paused" }).body).toEqual({ status: "PAUSED" });
    expect(() => buildMetaExecutionRequest("ad", "123456789", { field: "status", to: "DELETED" })).toThrow(MetaExecutionError);
  });

  it("refuses NaN, negative, zero, absurd and non-numeric budgets", () => {
    for (const to of ["abc", NaN, -5, 0, MAX_DAILY_BUDGET_GBP + 1, Infinity, "1e400", ""]) {
      expect(() => buildMetaExecutionRequest("adset", "123456789", { field: "daily_budget_gbp", to }), String(to)).toThrow(MetaExecutionError);
    }
  });

  it("refuses entity ids that are not Meta object ids (path injection)", () => {
    for (const id of ["../me/adaccounts", "123/insights", "act_123", "", 123456789, null, undefined, "1234", "12345678901234567890123456"]) {
      expect(() => buildMetaExecutionRequest("adset", id, { field: "status", to: "PAUSED" }), String(id)).toThrow(MetaExecutionError);
    }
  });

  it("refuses unknown fields instead of treating them as a status write", () => {
    expect(() => buildMetaExecutionRequest("adset", "123456789", { field: "bid_amount", to: 100 })).toThrow(/cannot be executed/);
    expect(() => buildMetaExecutionRequest("adset", "123456789", null)).toThrow(/nothing to execute/);
  });
});

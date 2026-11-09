import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, error, readJson, requireEnv, requireServiceRole, secretsEqual } from "../../supabase/functions/_shared/http";

type DenoStub = { env: { get(k: string): string | undefined } };
const g = globalThis as { Deno?: DenoStub };

function stubEnv(vars: Record<string, string | undefined>): void {
  g.Deno = { env: { get: (k) => vars[k] } };
}

function request(auth?: string): Request {
  return new Request("https://example.test/fn", { method: "POST", headers: auth ? { authorization: auth } : {} });
}

describe("edge function auth helper", () => {
  const original = g.Deno;
  beforeEach(() => stubEnv({ SUPABASE_SERVICE_ROLE_KEY: "service-role-key", FUNCTIONS_SHARED_SECRET: "shared-secret-123" }));
  afterEach(() => {
    g.Deno = original;
  });

  it("accepts the dedicated shared secret", () => {
    expect(requireServiceRole(request("Bearer shared-secret-123"))).toBeNull();
  });
  it("still accepts the service-role key for backwards compatibility", () => {
    expect(requireServiceRole(request("Bearer service-role-key"))).toBeNull();
  });
  it("rejects a wrong secret, a wrong scheme, a prefix and a missing header with 401", async () => {
    for (const auth of ["Bearer nope", "Basic shared-secret-123", "Bearer shared-secret-12", "Bearer shared-secret-1234", undefined]) {
      const res = requireServiceRole(request(auth));
      expect(res?.status, String(auth)).toBe(401);
      expect(await res!.json()).toEqual({ error: "unauthorised" });
    }
  });
  it("rejects everything when no secret is configured", () => {
    stubEnv({});
    expect(requireServiceRole(request("Bearer anything"))?.status).toBe(401);
  });
  it("works with only the shared secret configured (service-role key never leaves the database layer)", () => {
    stubEnv({ FUNCTIONS_SHARED_SECRET: "only-this" });
    expect(requireServiceRole(request("Bearer only-this"))).toBeNull();
    expect(requireServiceRole(request("Bearer service-role-key"))?.status).toBe(401);
  });

  it("secretsEqual is exact and handles length mismatches and unicode", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "ab")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual("", "a")).toBe(false);
    expect(secretsEqual("ünï", "ünï")).toBe(true);
    expect(secretsEqual("ünï", "uni")).toBe(false);
  });

  it("requireEnv returns the value or throws a named error", () => {
    expect(requireEnv("SUPABASE_SERVICE_ROLE_KEY")).toBe("service-role-key");
    expect(() => requireEnv("META_ACCESS_TOKEN")).toThrow(/Missing required environment variable META_ACCESS_TOKEN/);
  });

  it("json/error/readJson keep their shapes", async () => {
    expect(json({ a: 1 }).status).toBe(200);
    expect(json({ a: 1 }).headers.get("content-type")).toBe("application/json");
    expect(error("bad").status).toBe(400);
    expect(await error("bad", 418).json()).toEqual({ error: "bad" });
    expect(await readJson(new Request("https://x.test", { method: "POST", body: "{not json" }))).toEqual({});
    expect(await readJson(new Request("https://x.test", { method: "POST", body: JSON.stringify({ ok: true }) }))).toEqual({ ok: true });
  });
});

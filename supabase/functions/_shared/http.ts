/**
 * Shared helpers for the Edge Functions. Functions import the pipeline code
 * from ../../../src directly: it is plain TypeScript with no Node-only
 * imports on these paths, and deno.json enables sloppy imports so the
 * extensionless imports the repo uses resolve under Deno.
 *
 * This module has no Deno-specific imports so it can be unit-tested under
 * Node (tests/infra/edge-http.test.ts); the runtime is reached through
 * `globalThis.Deno` when present.
 */
export const JSON_HEADERS = { "content-type": "application/json" } as const;

type EnvReader = { env: { get(k: string): string | undefined } };

function env(name: string): string | undefined {
  return (globalThis as { Deno?: EnvReader }).Deno?.env.get(name);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Read a required environment variable or fail with a clear message instead of a TypeError deep in a client library. */
export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Constant-time string comparison: the loop always runs over the full
 * expected length and the result does not short-circuit on the first
 * mismatching byte, so response time does not leak how much of the secret
 * a caller guessed.
 */
export function secretsEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % Math.max(1, x.length)] ?? 0) ^ (y[i % Math.max(1, y.length)] ?? 0);
  return diff === 0;
}

/**
 * Only n8n / pg_cron / the app may call these functions. They present either
 * the dedicated FUNCTIONS_SHARED_SECRET (preferred: it grants nothing but the
 * right to call these functions) or, for backwards compatibility, the
 * service-role key.
 */
export function requireServiceRole(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return error("unauthorised", 401);
  const presented = auth.slice("Bearer ".length);
  const accepted = [env("FUNCTIONS_SHARED_SECRET"), env("SUPABASE_SERVICE_ROLE_KEY")].filter((s): s is string => Boolean(s));
  if (accepted.length === 0) return error("unauthorised", 401);
  // Compare against every configured secret so timing does not reveal which one is set.
  let ok = false;
  for (const secret of accepted) ok = secretsEqual(presented, secret) || ok;
  return ok ? null : error("unauthorised", 401);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

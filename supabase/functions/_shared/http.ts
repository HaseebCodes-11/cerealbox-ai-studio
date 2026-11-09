/**
 * Shared helpers for the Edge Functions. Functions import the pipeline code
 * from ../../../src directly: it is plain TypeScript with no Node-only
 * imports on these paths, and deno.json enables sloppy imports so the
 * extensionless imports the repo uses resolve under Deno.
 */
export const JSON_HEADERS = { "content-type": "application/json" } as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Only n8n / pg_cron / the app may call these functions; they present the service-role key. */
export function requireServiceRole(req: Request): Response | null {
  const expected = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("authorization") ?? "";
  if (!expected || auth !== `Bearer ${expected}`) return error("unauthorised", 401);
  return null;
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

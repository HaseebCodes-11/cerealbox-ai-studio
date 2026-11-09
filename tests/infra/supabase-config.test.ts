/**
 * Lint the Supabase migration and Edge Function configuration for the
 * production-breaking gaps found in the audit (SEC-01, COST-06).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, text: readFileSync(join(MIGRATIONS, f), "utf8") }));

describe("supabase migration", () => {
  it("has at least one migration", () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it("every scheduled net.http_post sends an Authorization header (SEC-01)", () => {
    const calls = sql.flatMap(({ file, text }) => [...text.matchAll(/net\.http_post\(([\s\S]*?)\);/g)].map((m) => ({ file, call: m[1] ?? "" })));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const { file, call } of calls) {
      expect(call, `${file}: ${call.slice(0, 80)}`).toMatch(/Authorization/);
      expect(call, `${file}: ${call.slice(0, 80)}`).toMatch(/app\.functions_secret/);
    }
  });

  it("every table has row level security enabled", () => {
    const text = sql.map((s) => s.text).join("\n");
    const tables = [...text.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(text, `RLS missing on ${t}`).toMatch(new RegExp(`alter table\\s+${t}\\s+enable row level security`));
  });

  it("exposes the monthly model cost view for finance (COST-06)", () => {
    const text = sql.map((s) => s.text).join("\n");
    expect(text).toMatch(/create (or replace )?view model_cost_monthly/);
  });
});

describe("edge functions", () => {
  const dirs = readdirSync("supabase/functions").filter((d) => !d.startsWith("_") && !d.includes("."));
  it("every function authenticates the caller and reads env through requireEnv (SEC-02, SEC-09)", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    for (const d of dirs) {
      const src = readFileSync(join("supabase/functions", d, "index.ts"), "utf8");
      expect(src, d).toMatch(/requireServiceRole\(req\)/);
      expect(src, d).not.toMatch(/Deno\.env\.get\("SUPABASE_(URL|SERVICE_ROLE_KEY)"\)!/);
    }
  });
});

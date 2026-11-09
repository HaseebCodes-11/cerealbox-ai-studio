/**
 * Bundle budget for the web app (PERF-02). Runs after `vite build` in
 * `npm run verify` and fails when a chunk or the total grows past the budget,
 * so a stray heavy import is caught in CI rather than by a user on a slow
 * connection.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUDGET = {
  /** Largest single JavaScript chunk, bytes. Recharts alone is ~380 KB. */
  largestChunkBytes: 450 * 1024,
  /** All JavaScript together, bytes. */
  totalJsBytes: 900 * 1024,
  /** All CSS together, bytes. */
  totalCssBytes: 64 * 1024,
};

export function measure(assetsDir = "web/dist/assets"): { js: Array<{ file: string; bytes: number }>; css: Array<{ file: string; bytes: number }> } {
  const files = readdirSync(assetsDir).map((f) => ({ file: f, bytes: statSync(join(assetsDir, f)).size }));
  return { js: files.filter((f) => f.file.endsWith(".js")), css: files.filter((f) => f.file.endsWith(".css")) };
}

export function check(assetsDir = "web/dist/assets", budget = BUDGET): { ok: boolean; lines: string[] } {
  const { js, css } = measure(assetsDir);
  const totalJs = js.reduce((s, f) => s + f.bytes, 0);
  const totalCss = css.reduce((s, f) => s + f.bytes, 0);
  const largest = js.reduce((m, f) => (f.bytes > m.bytes ? f : m), { file: "-", bytes: 0 });
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  const lines = [
    ...js.sort((a, b) => b.bytes - a.bytes).map((f) => `  ${kb(f.bytes).padStart(8)}  ${f.file}`),
    ...css.map((f) => `  ${kb(f.bytes).padStart(8)}  ${f.file}`),
    `  largest chunk ${kb(largest.bytes)} (budget ${kb(budget.largestChunkBytes)}) · total JS ${kb(totalJs)} (budget ${kb(budget.totalJsBytes)}) · CSS ${kb(totalCss)} (budget ${kb(budget.totalCssBytes)})`,
  ];
  const ok = js.length > 0 && largest.bytes <= budget.largestChunkBytes && totalJs <= budget.totalJsBytes && totalCss <= budget.totalCssBytes;
  return { ok, lines };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/check-bundle.ts");
if (isMain) {
  const result = check();
  console.log(`Web bundle budget\n${result.lines.join("\n")}`);
  if (!result.ok) {
    console.error("Bundle budget exceeded.");
    process.exit(1);
  }
}

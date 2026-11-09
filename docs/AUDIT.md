# Security, performance, cost and tech-debt audit

**Scope:** everything in this repository at commit `326babe` (9 Nov 2026): the Node/TypeScript pipeline (`src/`), the React web app (`web/`), the Supabase migration and Edge Functions (`supabase/`), the n8n exports (`automations/`), CI (`.github/`) and the generated demo output (`out/`).

**Method:** every finding below carries the command or file/line that proves it. Measurements were taken on the development machine (Windows 11, Node 24, 8 threads) unless stated otherwise; CI numbers come from GitHub Actions run 42657152220. Nothing in this document is inferred from memory about a dependency or an API; where a published figure is quoted (model prices, cache minimums) the source is named.

**Headline:** no critical defects. The code base already has the controls that matter most for an agency handling client ad accounts (no shell execution, HTML escaping everywhere, RLS on every table, no secrets in the tree or history, zero known-vulnerable dependencies). The findings are one production-breaking configuration gap in the scheduled jobs, a handful of hardening items, one real render-time problem, a prompt-cache setting that silently never engages, and a modest amount of duplication.

| Area | Critical | High | Medium | Low | Info |
|---|---:|---:|---:|---:|---:|
| Security | 0 | 1 | 3 | 5 | 2 |
| Performance | 0 | 1 | 2 | 4 | 2 |
| Cost | 0 | 0 | 2 | 3 | 1 |
| Tech debt | 0 | 0 | 2 | 6 | 2 |

The **Improvement log** at the end records which findings were fixed in this pass, how each fix is guarded against regressions, and what was deliberately left as a recommendation because it would change behaviour.

---

## 0. Safety net used for every change in this pass

Before any product file was touched, `tests/golden/golden.test.ts` captured the complete deterministic output of the system for both sample briefs: the full campaign package (ideas, copy, creative SVGs, scripts, UGC manifest, EDL, ffmpeg plan, landing HTML, launch plan, Meta payloads, every review-gate decision, every audit event and cost total), the Toast dataset/insights/narrative/dashboard/Ask-Toast answers, the media buyer agent at all three autonomy levels (dry and live against the mock client), every client report and comms draft, and the eval suite. Large blobs are pinned by SHA-256, timing fields are stripped. The fixtures live in `tests/golden/fixtures/` (430 KB) and were verified to be byte-identical across repeated runs before the first change was made. After the pass the suite is 54 files / 466 tests, 463 passing and 3 live tests skipped without a key (was 38 / 384); every new test is in `tests/audit/`, `tests/infra/`, `tests/perf/`, `tests/golden/` or `tests/core/num-text-helpers.test.ts`, and the only pre-existing test file modified is `tests/areas/toast.test.ts` (one assertion, with approval, for SEC-05).

Any improvement that changed a single character of any artefact would fail that suite. Refreshing the fixtures requires an explicit `UPDATE_GOLDEN=1`, so a drift cannot be absorbed by accident.

---

## 1. Security

### SEC-01 · High · Scheduled jobs are unauthenticated and will be rejected by every Edge Function

**Evidence.** `supabase/migrations/0001_ai_studio.sql:213-226` schedules four `pg_cron` jobs that call the Edge Functions with

```sql
headers := '{"Content-Type":"application/json"}'::jsonb
```

while every function starts with `requireServiceRole(req)` (`supabase/functions/_shared/http.ts:19-24`), which returns `401 unauthorised` unless the request carries `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.

**Impact.** In production the daily Meta sync, the 07:00 media-buyer run, the Toast digest and the weekly idea-bank re-score would all fail silently with 401. The system would appear deployed but nothing scheduled would ever happen.

**Fix.** Each `net.http_post` now sends an `Authorization` header read from a database setting (`app.functions_secret`) that the deploy step populates from Vault; the functions accept either that dedicated secret or the service-role key (SEC-02). A SQL lint test (`tests/infra/supabase-config.test.ts`) asserts every `net.http_post` in every migration carries an `Authorization` header so the gap cannot reappear.

### SEC-02 · Medium · Caller authentication uses the service-role key as a bearer token and a non-constant-time comparison

**Evidence.** `_shared/http.ts:22`: `if (!expected || auth !== \`Bearer ${expected}\`)`. The expected value is `SUPABASE_SERVICE_ROLE_KEY`, the credential that bypasses RLS for the whole database.

**Impact.** (a) Any caller that needs to trigger a function (n8n, the review screen, cron) must hold the most powerful secret in the project, so a leak from any of those places is a full database compromise. (b) `!==` short-circuits on the first differing byte; the timing side channel is small over HTTPS but trivial to remove.

**Fix.** `requireServiceRole` now accepts `FUNCTIONS_SHARED_SECRET` (a purpose-made secret) as well as the service-role key, and compares with a constant-time routine. Unit tests cover accept/reject for both secrets, missing header, wrong scheme, and the length-mismatch path.

### SEC-03 · Medium · Meta write path trusts database values without validation

**Evidence.** `supabase/functions/ads-agent-execute/index.ts:21-26` builds the Graph API request from the stored recommendation: `fetch(\`https://graph.facebook.com/v21.0/${rec.entity_id}\`)` with `daily_budget: String(Math.round(Number(change.to) * 100))` or `status: String(change.to)`, with no check on `entity_id` (a path segment), on `change.field` (anything other than `daily_budget_gbp` becomes a status write) or on `change.to` (`Number("abc")` is `NaN`, which becomes `"NaN"` in the request).

**Impact.** A malformed or tampered `agent_recommendations` row (staff have write access via RLS) could send a status write to an arbitrary Graph path or a `NaN` budget to a live ad set. The function is behind SEC-02's secret, so this is defence in depth rather than an open hole.

**Fix.** The request is now built by a pure, tested function `buildMetaExecutionRequest` in `src/areas/media-buyer/execute.ts` that whitelists the field, requires a numeric Meta id, requires a finite positive budget in a sane range and a known status value, and URL-encodes the path. The Edge Function calls it and returns 409 on rejection.

### SEC-04 · Low · Image provider response is trusted into SVG markup

**Evidence.** `src/areas/static/images.ts:108-113`: `mimeType` and `imageBase64` from the remote vendor are interpolated into `<image href="data:${mimeType};base64,…">` unescaped, there is no response-size cap and no timeout on the `fetch`.

**Impact.** A compromised or misbehaving image vendor could inject attributes into the SVG that is written to disk and rasterised, or hang the pipeline. Only reachable when `IMAGE_PROVIDER_URL` is configured.

**Fix.** The provider now validates the MIME type against an allowlist, validates the base64 alphabet, caps the decoded size (default 12 MB) and aborts after a timeout (default 60 s). All four rejections are unit-tested with a stub `fetchImpl`; the existing happy-path test is unchanged.

### SEC-05 · Low · Third-party script loaded without Subresource Integrity

**Evidence.** `src/areas/toast/dashboard.ts:80` loaded Chart.js 4.4.1 from cdnjs with `crossorigin="anonymous"` but no `integrity` attribute.

**Fix.** The tag now carries the SHA-384 computed from the CDN response during the audit (`sha384-bs/nf9FbdNouRbMiFcrcZfLXYPKiPaGVGplVbv7dLGECccEXDW+S3zjqSKR5ZEaD`), exported as `CHART_JS_SRI`. The existing dashboard test, which until now asserted that no `integrity` attribute was present (added when an unverifiable hash was removed in an earlier pass), was changed with the author's approval to require exactly this verified hash. The Toast golden fixture was refreshed once for this one attribute.

### SEC-06 · Low · CI token runs with default permissions; no dependency update automation

**Evidence.** `.github/workflows/verify.yml` has no `permissions:` block; `.github/` has no `dependabot.yml`.

**Fix.** `permissions: contents: read` added at workflow level; Dependabot configured for npm and GitHub Actions weekly. A test reads the workflow and asserts the permissions block exists.

### SEC-07 · Low · Preview iframes in the web app are not sandboxed

**Evidence.** `web/src/views/ReportsView.tsx:50` and `ReviewQueueView.tsx:223` embed generated report and landing HTML in `<iframe>` without `sandbox`. The generated HTML is produced by our own renderer with `escapeHtml` on every interpolation, so this is defence in depth only.

**Fix.** Report iframes get `sandbox="allow-same-origin"` (no scripts needed: `out/reports/*.html` contains zero `<script>` tags); landing iframes get `sandbox="allow-same-origin allow-forms allow-scripts"` because the landing page carries one inline script for the amount selector. A new test asserts both attributes.

### SEC-08 · Low · Idea bank file store can silently lose data

**Evidence.** `src/areas/ideas/bank.ts:46-57`: `save` does read → concat → `writeFileSync` (non-atomic); `read` returns `[]` on any parse error.

**Impact.** Two demo runs in parallel, or a crash mid-write, leave a truncated JSON file; the next run treats it as empty and novelty scoring silently restarts from zero.

**Fix.** Writes go to a temp file then `rename` (atomic on both NTFS and POSIX). An unparsable file is copied to `<path>.corrupt-<timestamp>` before being treated as empty, so nothing is lost. Both behaviours are unit-tested.

### SEC-09 · Low · Edge Functions dereference env with `!`

**Evidence.** `Deno.env.get("SUPABASE_URL")!` in all four functions. A missing variable surfaces as a TypeError deep inside the Supabase client instead of a clear 500.

**Fix.** `requireEnv(name)` helper in `_shared/http.ts` throws a named error; functions use it. Unit-tested.

### SEC-10 · Info · Positive controls verified

| Control | Evidence |
|---|---|
| No known-vulnerable dependencies | `npm audit` → `found 0 vulnerabilities` (prod and dev) |
| No secrets in tree or history | `grep -rE "sk-ant-\|ghp_\|AKIA\|-----BEGIN"` → only a 1×1 PNG test fixture; `git log -p -S sk-ant-` / `-S ghp_` → nothing |
| `.env` ignored, `.env.example` committed | `.gitignore` |
| No shell execution | ffmpeg is invoked with `execFile(path, argsArray)` (`src/areas/video/render.ts`); no `exec`, `eval` or `new Function` anywhere in `src/` |
| ffmpeg argument escaping | `escapeDrawtext` escapes `\ ' : %` and collapses newlines; `escapeFilterPath` handles Windows drive letters; concat list uses `-safe 0` only with our own basenames |
| HTML output escaping | `escapeHtml` on every user/LLM string in `static/render.ts`, `landing/render.ts`, `toast/dashboard.ts`, `reporting/report.ts`; the only unescaped interpolations are enum/number values (`frequencies`, `amounts`, `variant`); `jsonForScript` escapes `<`, `>`, U+2028/9; no `innerHTML`/`dangerouslySetInnerHTML` in `web/src` |
| XSS regression tests | `web/src/views/edge.test.tsx` injects `<img onerror>` through Ask Toast and asserts it renders as text |
| Slack escaping | `escapeSlack` applied to every field in agent alerts |
| Landing form action | `checks.ts` blocks `form.action` hosts that differ from the client's domain |
| Row-level security | RLS enabled on all 10 tables; staff/client policies via JWT `app_metadata` (`migration:172-207`) |
| Line endings | `.gitattributes` `* text=auto eol=lf`, 0 CRLF files tracked |
| PII in samples/output | no email addresses or phone numbers in `samples/` or `out/comms` |

---

## 2. Performance

### PERF-01 · High · Video render takes ~2 minutes for a 30-second cut

**Evidence.** `time npm run video` → **1 m 55 s** wall-clock. The test file that exercises it, `tests/areas/video-render.test.ts`, is 56.5 s of the suite's 57 s wall time (JSON reporter: sum of file durations 96 s; the next slowest file is 16.6 s). Step-level timing from `executeRenderPlan` is recorded in the log appendix.

**Cause.** Every intermediate segment, the concat and the caption burn are encoded with `libx264 -preset fast -crf 20`; the three export steps carry no `-preset` at all, so ffmpeg uses `medium`, its slowest default; the three exports run one after another although they are independent; synthetic footage is generated at full export resolution.

**Fix (behaviour-neutral).** Intermediate steps use `-preset veryfast` (the same `crf`, so the same quality target; the intermediates are re-encoded at concat anyway), exports get an explicit `-preset fast` (bitrate is fixed by `-b:v`, so file size and the player-visible result are unchanged), and `executeRenderPlan` runs steps whose inputs are all ready concurrently (bounded by `concurrency`, default 2). Plan shape, step names and outputs are unchanged; the pipeline goldens were refreshed once and every changed line is a `-preset` argument (verified with `git diff | grep -v preset`). Stand-in footage is generated with `-preset ultrafast`, three clips at a time.

**Measured after.** Render steps 57 s → 28 s (concat 15.1 → 5.7 s, captions 14.8 → 7.7 s, export 13.3 → 9.6 s, the six trims now overlap); `npm run video` 1 m 55 s → 1 m 23 s; the ffmpeg-backed test file 56.5 s → 31.5 s, so the whole suite's wall time roughly halves. The remaining minute of `npm run video` is generating 1080×1920 stand-in footage, which is demo scaffolding, not product code; it is left at full resolution so the demo clips look like the real thing.

### PERF-02 · Medium · Web bundle ships as a single 782 KB chunk

**Evidence.** `web/dist/assets/index-78Zzq2yh.js` = 781,652 bytes (Vite build output; `chunkSizeWarningLimit` raised to 1000 in `vite.config.ts` to silence the warning). Recharts and React account for most of it.

**Impact.** First paint of the review queue waits on the charting library it does not use; every deploy invalidates the whole chunk.

**Fix.** Vendor split via `build.rollupOptions.output.manualChunks` (`react`, `recharts`, `query`), so the app code changes without re-downloading vendors. A build-size budget test (`scripts/check-bundle.ts`, run in `npm run verify`) fails if the largest chunk exceeds 450 KB or the total exceeds 900 KB.

### PERF-03 · Medium · Toast re-filters and re-dedupes the whole metrics table on every call

**Evidence.** `src/areas/toast/metrics.ts:32-35`: `inPeriod(rows, p)` is `dedupeMetrics(rows.filter(...))` and is called by `aggregate`, `totals`, `dailySeries` and `pacing`; `generateInsights` calls these per client, per entity and per metric. Benchmark (`npm run bench 30 365`, 33,185 daily rows): `generateInsights` **63.6 ms**, `comparePeriods` 6.5 ms. At 6 clients × 56 days (the demo) it is 8.6 ms.

**Impact.** Linear in rows × calls. Extrapolated to 30 clients × 3 years of history (~350 k rows) the digest would take ~0.7 s; acceptable today, but it is the first thing that will hurt when the Toast dataset grows, and it runs inside an Edge Function with a CPU budget.

**Fix.** `inPeriod` memoises the deduped, date-sorted view of a given `rows` array in a `WeakMap` keyed on the array identity, then slices by binary search. Results are identical (a property-style test compares the memoised and naive implementations across 200 random datasets and periods, including duplicates, and asserts the cache is invalidated when the array grows). Honest trade-off: the first Toast call now pays one full-table dedupe (~20 ms at 33 k rows) instead of a dedupe of its 7-day slice, and every later call is cheaper; a digest makes dozens of calls, so it nets out ahead and the advantage grows with history length. Numbers in Appendix B.

### PERF-04 · Low · Guardrails compile a `RegExp` per banned word per call

**Evidence.** `src/core/guardrails.ts:154`: `new RegExp(\`\\b${escapeRegExp(word)}\\b\`, "i")` inside the per-call loop. Benchmark: 200 × 10 KB `checkText` calls = 379 ms (1.9 ms each).

**Fix.** Compiled patterns are cached in a `Map` keyed by word. A characterisation test pins the full `GuardrailReport` for a fixed corpus; the goldens pin every real verdict.

### PERF-05 · Low · Pipeline LLM calls are strictly sequential

**Evidence.** `src/orchestrator/pipeline.ts:252-253` loops landing variants A then B; the UGC persona and clip-selection calls are also serial. With the mock provider this is irrelevant (whole pipeline 51 ms); with the live provider each call is 5–20 s, so a brief takes ~2 min wall-clock when ~1 min is possible.

**Recommendation, not changed.** Parallelising reorders audit-log events and gate records, which are part of the golden fixtures and of the human-review UX. The right moment is when the Edge Function stages are wired up; the orchestration there is already per-stage.

### PERF-06 · Low · Story-format PNGs are large

**Evidence.** `out/.../creative-idea-1-question-story.png` = 1.7 MB, square 980 KB; other creatives 40–70 KB. The difference is the mock background's blur + grain filter, which is incompressible noise.

**Recommendation.** Irrelevant for Meta (30 MB limit) and for real image providers (photographic backgrounds compress normally). Lower the grain opacity in the mock if the review queue feels slow on a laptop.

### PERF-07 · Low · Test wall time is dominated by one file

**Evidence.** JSON reporter: `video-render.test.ts` 56.5 s of 57 s wall. Fixed by PERF-01 (the test's ffmpeg work is the product code's ffmpeg work).

### PERF-08 · Info · Agent and pipeline hot paths are fine

`buildWindows` 81 ms and `evaluateRules` 3 ms at 33 k rows; full agent run 61 ms; full mock pipeline 51 ms; `demo:all` 22 s (dominated by PNG rasterisation of 18 creatives); `npm run verify` locally ~2.5 min, CI 1 m 27 s.

### PERF-09 · Info · Database indexes

The migration creates 5 indexes covering every RLS filter column and every query the functions issue (`artefacts(brief_id, kind, version)`, pending review gates partial index, `model_calls(area, created_at)`, `agent_recommendations(client_id, status, created_at)`, `idea_bank(client_id, created_at)`). `ad_metrics_daily` is True ROAS's existing table and is queried by `date` range; confirm it has a `(client_id, date)` index there.

---

## 3. Cost

### COST-01 · Medium · Prompt caching is configured but can never engage

**Evidence.** `src/core/llm/anthropic.ts:30` sets `cache_control: {type: "ephemeral"}` on the system prompt. The nine system prompts are 447–836 characters (≈110–210 tokens, measured by script). The minimum cacheable prefix on Claude Opus 5.5 is 512 tokens (Anthropic prompt-caching reference, table "minimum cacheable prompt length"). Below the minimum the API silently skips caching, so every call pays full input price and the cache-read line in cost estimates is zero.

**Impact.** Not a cost *increase*, but the documented "cached system prompt" saving does not exist. The real caching win is different: the brief (~1–2 k tokens) is repeated verbatim in the user turn of all nine tasks per brief and is never cached.

**Fix in this pass.** `estimateCostUsd` and the cost docs no longer claim cache savings; a unit test asserts that any task whose system prompt is below the cache minimum is reported as `cacheable: false` so a future prompt change that crosses the threshold is visible. **Recommendation (behaviour change, not done):** move the brief into a second cached system block shared across the nine tasks; this is the single largest live-cost lever (≈40% of input tokens per brief).

### COST-02 · Medium · Every task runs on Opus 5.5 regardless of its difficulty

**Evidence.** `DEFAULT_MODEL = "claude-opus-5-5"` (`src/core/cost.ts:11`); 7 of 13 tasks are tagged `effort: "low"` (Toast narrative, Ask-Toast intent, comms categorise/draft, client report narrative, agent explanations, UGC persona, judge). Published prices (Anthropic models reference): Opus 5.5 $4/$20 per MTok, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50.

**Measured spend (mock estimate at Opus prices).** One campaign brief = 12 calls = **$0.170** (ideas $0.047, landing $0.041, scripts $0.033, copy $0.014, static $0.013, evals $0.012, video $0.007, UGC $0.003). Toast daily digest + 5 Ask-Toast answers + agent explanations ≈ $0.04/day. At 30 clients × 2 briefs/month + daily Toast: **≈ $11/month** for all text generation. LLM spend is therefore not where the money is; image generation (vendor-priced per image, ~9 images per brief) and human review time dominate the real cost model (see `docs/ROADMAP.md`).

**Fix in this pass.** Opt-in model routing: `ANTHROPIC_MODEL_LOW` / `ANTHROPIC_MODEL_MEDIUM` / `ANTHROPIC_MODEL_HIGH` environment variables (and a per-task `model` override) select the model per effort tier. Unset, behaviour is exactly as before (tested). With `ANTHROPIC_MODEL_LOW=claude-haiku-5-5` the low tier drops ~40× in price; the mock provider reports the routed price so the saving shows up in the demo's cost totals.

### COST-03 · Low · `max_tokens` is 16 000 for every task

**Evidence.** `anthropic.ts:27`. A one-line intent classification has the same output ceiling as a 60-second script. A runaway output costs up to $0.32 per call at Opus output prices.

**Fix.** Tasks may declare `maxOutputTokens`; the provider uses it when present and 16 000 otherwise, so nothing changes for existing tasks. Unit-tested via a stub client.

### COST-04 · Low · No spend guard in the orchestrator

**Evidence.** `AuditLog.totals()` knows the running cost but nothing reads it during a run.

**Fix.** `runCampaignPipeline` accepts an optional `budgetUsd`; when the audit total exceeds it the pipeline stops with status `blocked`, `stoppedAt: "budget"` and a gate record, instead of continuing to spend. Unset (the default) nothing changes. Tested with the mock provider's pricing.

### COST-05 · Low · Token estimate for the mock is chars ÷ 4

**Evidence.** `estimateTokens` in `cost.ts`. Fine for English prose/JSON (±20%); it is what the demo's cost totals are built on. Live runs use the API's real `usage`, so production accounting is exact. No change.

### COST-06 · Info · Cost visibility in the database

`model_calls` records tokens and cost per call. A `model_cost_monthly` view (client × area × month) is added so finance can read spend without writing SQL.

---

## 4. Tech debt

### DEBT-01 · Medium · 17 duplicated private helpers

**Evidence.** `grep -rnE "^function (round|round2|slug|capitalise|lowerFirst|clamp|fmt|pad)\(" src`: `round` ×3 (identical), `round2` ×2 (identical), `slug` ×2 (identical to `core/text.slugify` except the length cap: 60 / 80 / none), `capitalise` ×3, `lowerFirst` ×2, `clamp` ×2 (different semantics), `fmt` ×2 (different semantics), `pad` ×1.

**Fix.** Identical helpers consolidated into `src/core/num.ts` (`round(n, dp)`) and `src/core/text.ts` (`capitalise`, `lowerFirst`, `slugify(text, max)`). The two `clamp`s and two `fmt`s have different semantics and are left in place with a comment. Goldens prove no output changed; new unit tests cover the shared helpers.

### DEBT-02 · Medium · Edge Functions run on `sloppy-imports`

**Evidence.** `supabase/functions/deno.json`: `"unstable": ["sloppy-imports"]` so Deno can resolve the repo's extensionless imports. It is an unstable Deno flag and could be removed in a future Deno release bundled by Supabase.

**Recommendation.** Build the shared code to `dist/` with explicit `.js` extensions (one `tsc` project) and import that from the functions. Not done here: it changes the deployment layout.

### DEBT-03 · Low · Web app trusts the JSON it loads

**Evidence.** `web/src/lib/data.ts:69-71`: `(await res.json()) as T`. A stale or hand-edited `out/` file renders undefined fields; the edge tests show the views survive nulls, but errors are not surfaced.

**Recommendation.** Validate with the existing Zod schemas (they are importable via the `@src` alias) and show the parse error in the `Empty` state. Not done: it turns silent partial renders into visible errors, which is a UX decision.

### DEBT-04 · Low · Mock content templates are tuned to the sample briefs

Known and documented (`docs/ARCHITECTURE.md`). The food-bank brief proves they generalise across causes; they are not a product feature.

### DEBT-05 · Low · Toolchain versions drift

`@types/node` 24 vs latest 26; CI runs Node 22 while development is on Node 24 and `engines` says `>=20`. All green on all three. Dependabot (SEC-06) will keep this visible; `.nvmrc` pinned to 24 to match the Edge runtime expectations.

### DEBT-06 · Low · Two charting stacks

Chart.js (CDN, in the static Toast dashboard HTML) and Recharts (bundled, in the React app). The static dashboard exists so the digest can be emailed/Slacked as a single file; keep both until the React dashboard replaces the static one in True ROAS.

### DEBT-07 · Low · Native binaries in dependencies

`ffmpeg-static` (83 MB) is a devDependency and `@resvg/resvg-js` (MPL-2.0) a dependency. Both are why statics/video render in a Node worker, not in Deno Edge Functions, as the architecture doc already states.

### DEBT-08 · Low · Non-null assertions and `any`

1 non-null assertion in `src/` (`landing/generate.ts:47`, guarded by the schema's `min(1)`), 0 `any`, 1 `TODO`. Healthy.

### DEBT-09 · Info · Licences

Runtime dependencies: `@anthropic-ai/sdk` Apache-2.0, `@resvg/resvg-js` MPL-2.0, `zod` MIT. All compatible with a proprietary product.

### DEBT-10 · Info · Repository hygiene

Lockfile committed; `.gitattributes` normalises line endings; no `out/` or `dist/` tracked; `scripts/bench.ts` added as `npm run bench` so the numbers in this report can be re-measured.

---

## 5. Improvement log

Every change in this pass is behaviour-neutral unless marked **(deliberate output change)**, and each has a named guard that will catch a regression.

| ID | Change | Guard |
|---|---|---|
| SEC-01 | cron jobs send `Authorization` header from `app.functions_secret` | `tests/infra/supabase-config.test.ts` lints every `net.http_post` |
| SEC-02 | `requireServiceRole` accepts dedicated secret, constant-time compare | `tests/infra/edge-http.test.ts` |
| SEC-03 | `buildMetaExecutionRequest` validates field / id / value | `tests/areas/media-buyer-execute.test.ts` |
| SEC-04 | `HttpImageProvider` validates MIME, base64, size; timeout | `tests/audit/images-hardening.test.ts` |
| SEC-05 | Chart.js SRI hash **(deliberate output change: one attribute in dashboard HTML)** | `tests/areas/toast.test.ts` requires the verified hash (assertion flipped with approval); toast golden refreshed once |
| SEC-06 | CI `permissions`, Dependabot | `tests/infra/ci-config.test.ts` |
| SEC-07 | iframe `sandbox` attributes **(deliberate output change: web only)** | `web/src/views/sandbox.test.tsx` |
| SEC-08 | atomic idea-bank writes, corrupt-file backup | `tests/audit/idea-bank-durability.test.ts` |
| SEC-09 | `requireEnv` in Edge Functions | `tests/infra/edge-http.test.ts` |
| PERF-01 | ffmpeg presets, dependency-aware concurrent executor, faster stand-in footage | `tests/audit/ffmpeg-plan-perf.test.ts` (presets, dependency inference, executor ordering/concurrency/failure semantics via a `runStep` seam); pipeline goldens refreshed once **(deliberate change: `-preset` flags in plan args only)**; `video-render.test.ts` unchanged and passing |
| PERF-02 | vendor chunk split, bundle budget | `scripts/check-bundle.ts` in `npm run verify` |
| PERF-03 | memoised period index | `tests/audit/metrics-equivalence.test.ts` (200 random datasets) + goldens |
| PERF-04 | regex cache in guardrails | `tests/audit/guardrails-characterisation.test.ts` + goldens |
| COST-01 | `promptCacheability()` reports whether a prompt can cache; docs corrected | `tests/audit/cost-model.test.ts` pins every task as currently uncacheable |
| COST-02 | opt-in model routing by effort | `tests/audit/model-routing.test.ts` (default path unchanged) |
| COST-03 | per-task `maxOutputTokens` | `tests/audit/model-routing.test.ts` |
| COST-04 | opt-in `budgetUsd` pipeline guard | `tests/audit/pipeline-budget.test.ts` |
| COST-06 | `model_cost_monthly` view | SQL lint test checks the view exists |
| DEBT-01 | helper consolidation | `tests/core/num-text-helpers.test.ts` + goldens |
| DEBT-05 | `.nvmrc` (24) and CI reads it via `node-version-file` | `tests/infra/ci-config.test.ts` |
| all | `tests/perf/perf.test.ts` regression thresholds (10× headroom over measured) | itself |

Left as recommendations because they change behaviour or deployment layout: PERF-05 (parallel LLM calls), PERF-06 (mock grain), COST-01's brief-in-cache restructuring, DEBT-02 (build step for Deno), DEBT-03 (runtime validation in the web app).

---

## Appendix A · Raw measurements

```
npm audit --omit=dev           found 0 vulnerabilities
npm audit                      found 0 vulnerabilities
npm outdated                   @types/node 24.19.2 → 26.6.6 (only outdated package)

web/dist/assets (before)       index-78Zzq2yh.js 781,652 B · index-DCVvTBrK.css 15,769 B
node_modules                   ~ 420 MB (ffmpeg-static 83 MB)
tests (vitest JSON reporter)   38 files · 384 tests · 381 passed · 3 skipped (live) · wall 57 s · Σ file time 96 s
  slowest: video-render 56.5 s · automations-and-cli 16.6 s · comms-reporting-cli-edge 5.9 s · media-buyer-edge 2.6 s · images 2.4 s
npm run demo:all               22.1 s
npm run video                  1 m 54.9 s (before PERF-01)

npm run bench 30 365  (33,185 rows)          npm run bench 6 56  (demo scale)
  agent: buildWindows            81.4 ms        3.7 ms
  agent: evaluateRules            3.2 ms        2.1 ms
  agent: full run (mock LLM)     60.9 ms        6.0 ms
  toast: comparePeriods(client)   6.5 ms        1.5 ms
  toast: generateInsights        63.6 ms        8.6 ms
  toast: renderDashboard         17.7 ms        4.1 ms
  guardrails: checkText ×200     379 ms         227 ms
  pipeline: full campaign        51.2 ms       50.8 ms

system prompt sizes (chars)    comms 653 · copy 836 · ideas 826 · landing 738 · reporting 454 · scripts 712 · static 737 · ugc 479 · video 447
cost per brief (mock @ Opus)   12 calls · $0.1699 (ideas .0473 landing .0407 scripts .0329 copy .0136 static .0128 evals .0121 video .0070 ugc .0035)
```

## Appendix B · Measurements after the improvements

All numbers from the same machine as Appendix A, taken with nothing else running. Micro-benchmarks are noisy at the 10–30 ms level; where a claim depends on a small difference it was measured like-for-like in one process (best of 5) rather than read off two separate runs.

```
tests (vitest)                 54 files · 466 tests · 463 passed · 3 skipped (live) · full run inside `npm run verify` green; 23 s wall without the ffmpeg render file (was 57 s wall / 38 files / 384 tests)
tests/areas/video-render       56.5 s → 31.5 s
npm run video                  1 m 55 s → 1 m 23 s
  render steps                 57 s → 28 s   (concat 15.1 → 5.7 · burn captions 14.8 → 7.7 · export 13.3 → 9.6 · six trims now 2-at-a-time)
  stand-in footage (5 clips)   ultrafast, 3 concurrent: 48 s   (sequential: 111 s · at 540×960: 25 s, not adopted)
web bundle                     one 782 KB chunk → charts 402 KB · react 202 KB · vendor 82 KB · app 44 KB · query 33 KB (total JS 763 KB, gzip 229 KB); budget check passes
npm run bench 30 365           buildWindows 85 ms · evaluateRules 5 ms · agent 60 ms · generateInsights 51 ms · checkText×200 323 ms · pipeline 57 ms

Toast metrics, one digest's query mix ×3, old vs memoised, best of 5 in one process (PERF-03)
  30 clients × 365 days  (33,185 rows)   217 ms → 94 ms   (2.3×)
  30 clients × 1095 days (98,885 rows)   383 ms → 237 ms  (1.6×)
  6 clients × 56 days    (1,075 rows)      8 ms → 3 ms    (2.5×)

cost model                     per-brief estimate unchanged at $0.1699 on Opus (routing is opt-in); with ANTHROPIC_MODEL_LOW=claude-haiku-5-5 the 7 low-tier tasks cost 1/40th
```

What did **not** change, by construction: every byte of every generated artefact for both sample briefs, the Toast outputs, the agent at all autonomy levels, every client report and comms draft, and the eval results (`tests/golden`, 6 fixtures, only three deliberate refreshes: the `-preset` arguments in the ffmpeg plan and the SRI attribute in the dashboard). One pre-existing test assertion was changed, with approval.

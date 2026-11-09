# Production risk pass 2 · 59 defects from 133 new scenarios

**Date:** 10 November 2026. **Method:** every public feature surface was read end to end (brief schema, guardrails, text helpers, providers, ideas, copy, statics, scripts, UGC, landing, video, media buyer rules/agent/launch/execution, Toast metrics/ask/insights/dashboard, reports, comms, orchestrator, idea bank, CLI, automations, configuration and the four web views) and, for each, the ways a strategist, reviewer, client, data feed or operator would break it in production were written as tests before any fix. The first pass (`docs/PRODUCTION_RISKS.md`, 120 scenarios, 41 defects, all fixed) covered hostile input and obvious failure modes; this pass goes after the quieter ones: evasions, inconsistencies between tools, compliance gaps, silent fallbacks and state that leaks between items.

**Where the tests are:** `tests/edge-cases-2/*.test.ts` (7 files) and `web/src/views/edge2.test.tsx`. 133 scenarios; 74 pass today; the 59 that fail are marked `it.fails("[BUG2-nn] …")` so the suite stays green while each defect is open, and flips to a hard failure the moment the fix lands (the marker is then removed, as in the first pass). No pre-existing test file was changed.

| Severity | Meaning | Count |
|---|---|---:|
| S1 | Money, compliance or trust: wrong audience targeted, unlaunchable budgets, misleading claims, PII, contradictory actions on a live account | 12 |
| S2 | Correctness: crashes on legitimate input, wrong answers, false positives that erode reviewer trust, tools disagreeing | 27 |
| S3 | Experience and polish: confusing output, silent fallbacks, cosmetic defects | 20 |

## Defects by severity

| ID | Sev | Area | Scenario (test title) | Impact |
|---|---|---|---|---|
| BUG2-03 | S1 | brief | an end date before the start date is rejected | A campaign whose end precedes its start is accepted and flows into the Meta ad set payload, which Meta rejects at launch. |
| BUG2-06 | S1 | guardrails | a soft hyphen or zero-width space inside a blocked word does not hide it | Text pasted from Word carries soft hyphens and zero-width spaces; 'guaran­tee' slips past the claims check. |
| BUG2-07 | S1 | guardrails | international dialling prefix 0044 is caught like +44 | A UK number written as 0044 7700 900123 is not detected as PII because the candidate pattern only knows 0 and +44 prefixes. |
| BUG2-19 | S1 | copy | a charity that is not Gift Aid eligible gets no Gift Aid line anywhere in the copy pack | The copy pack always includes 'Gift Aid adds 25% at no cost' even for a charity that is not Gift Aid eligible. |
| BUG2-23 | S1 | ugc | a synthetic presenter is refused for a testimonial script even if the model proposes one | buildUgcManifest accepts a synthetic persona for a testimonial script if the model proposes one; a synthetic 'testimonial' is misleading and not permitted. |
| BUG2-26 | S1 | landing | offering Gift Aid on a page for a charity that is not eligible is blocked | No check stops a landing page from showing a Gift Aid declaration for a charity whose brief says it is not eligible. |
| BUG2-31 | S1 | media buyer | an ad set that is both far below ROAS floor and spiking in CPA gets one coherent action, not pause and trim together | The ROAS floor rule proposes pausing an ad set while the CPA rule proposes trimming its budget; on autopilot the trim executes and the pause waits, so money keeps flowing into an ad set the agent itself wants stopped. |
| BUG2-33 | S1 | media buyer | a budget step percentage of 100 or more is rejected by the config schema | budgetStepPct 150 is accepted and produces negative budget proposals. |
| BUG2-36 | S1 | launch | age ranges written as '65+', '35–55' (en dash) or '35 to 55' are honoured, not silently widened to 18-65 | '65+', '35–55' (en dash) and '35 to 55' all silently become 18-65 targeting, spending the client's budget on the wrong audience. |
| BUG2-37 | S1 | launch | a daily budget that splits below Meta's minimum per ad set is flagged in the bundle | A £3/day campaign is split into six ad sets of 50p; Meta rejects the budgets and nothing in the bundle warns about it. |
| BUG2-38 | S1 | launch | an end date before the start date never reaches the ad set payload | The bundle builder emits end_time earlier than start_time without complaint. |
| BUG2-45 | S1 | reporting | a week with spend but no donations never tells the client each donation 'cost £0' | A week with spend and zero donations produces a client report saying 'each donation cost £0 to acquire' and 'the average gift was £0'. |
| BUG2-02 | S2 | brief | blank strings inside list fields (proof points, motivations, tone) are rejected | Empty proof points, motivations or tone entries pass validation and surface as blank lines, '.' voiceovers and 'Trust: ' pillars in generated copy. |
| BUG2-04 | S2 | brief | campaign dates must be ISO dates, not prose like 'next Monday' | Prose dates ('next Monday') are accepted and become malformed start_time values in the launch payload. |
| BUG2-08 | S2 | guardrails | a year or a UK-format date is not reported as an invented statistic | 'Winter 2026', 'since 1998' and '12/11/2026' are flagged as invented statistics, training reviewers to ignore the warning. |
| BUG2-09 | S2 | guardrails | '1 in 10' is supported by an allowed fact written as 'one in ten' and vice versa | Number words in allowed facts are not normalised, so the same ratio written two ways is flagged. |
| BUG2-10 | S2 | guardrails | shorthand and long-form amounts verify against each other (£30k ↔ £30,000, 1.2m ↔ 1,200,000) | £30k is flagged when the proof point says £30,000 (and 1.2m vs 1,200,000); shorthand is excluded from numeric matching. |
| BUG2-11 | S2 | guardrails | an empty or whitespace-padded banned word never flags everything | An empty avoid-word matches every text (excerpt ''); a trailing-space avoid word misses 'vulnerable.' at the end of a sentence. |
| BUG2-15 | S2 | dates | an impossible calendar date is reported by name instead of a RangeError from toISOString | addDays('2026-02-30') silently rolls over to 2 March; a Toast or agent run 'as of' an impossible date reports the wrong day without any error. |
| BUG2-16 | S2 | ideas | selectIdeas with count 0 returns nothing even when formats are required | selectIdeas(ranked, 0, formats) returns one idea because the format-coverage pass pops then pushes; selectCount 0 therefore does not stop the pipeline. |
| BUG2-17 | S2 | ideas | excluding every angle still yields ideas (rotation resets instead of crashing) | When every angle is excluded the mock indexes an empty list and produces invalid ideas instead of resetting the rotation. |
| BUG2-22 | S2 | statics | a tier amount with pence and millions still produces a schema-valid stat value | A tier of £1,234,567.89 produces a 13-character stat value; the spec schema caps it at 12 and the concept step throws. |
| BUG2-24 | S2 | landing | a one-sentence case study still produces a schema-valid landing spec | A short caseStudy (allowed by the brief schema) produces a story body under the 60-character landing minimum and the landing step throws. |
| BUG2-25 | S2 | landing | a very short ask and client name still produce a title of at least 10 characters | 'Give | Yo' is under the 10-character title minimum, so a short ask plus a short client name crashes the landing step. |
| BUG2-28 | S2 | video | accepts Windows CRLF line endings without leaving carriage returns in the captions | An SRT exported from a Windows editor leaves \r on every caption line, which is burned into the video. |
| BUG2-30 | S2 | video | a subtitle path with an apostrophe, comma, semicolon or brackets is escaped for the filtergraph | escapeFilterPath only escapes backslashes and colons; a user folder such as C:\Users\Jo O'Brien breaks the subtitles filter and the render fails. |
| BUG2-32 | S2 | media buyer | ads inside a PAUSED ad set are not flagged for creative fatigue | The fatigue rule ignores ad set status and asks reviewers to act on ads that are not delivering. |
| BUG2-34 | S2 | media buyer | a client with zero delivery in the window gets a brief that says nothing ran, not 'steady, no action needed' | A client whose ads did not run gets a morning brief headlined 'steady, no action needed'. |
| BUG2-39 | S2 | toast | 'and' in a question matches a client whose name uses an ampersand | 'Paws and Place' does not match the client 'Paws & Place', so the question falls to 'unknown'. |
| BUG2-40 | S2 | toast | a client whose name is a prefix of another is not treated as two clients | 'Bright Start Trust' also matches 'Bright Start', so a single-client question becomes a comparison. |
| BUG2-44 | S2 | toast | a one-day window renders every KPI with a comparison against the day before | renderDashboard with days=1 prints NaN in the page. |
| BUG2-47 | S2 | reporting | a year written in prose is not an unverified figure | A live narrative that mentions a year ('since 2024') fails number verification and the whole report is marked 'needs review'. |
| BUG2-49 | S2 | pipeline | an empty script request list skips scripts, UGC and video instead of failing schema validation | scriptRequests: [] makes the mock return zero scripts, which fails the batch schema and aborts the run after ideas and copy were produced. |
| BUG2-50 | S2 | pipeline | an image provider outage does not throw away the ideas and copy already produced | A vendor error inside the image provider propagates out of runCampaignPipeline and loses the ideas and copy already generated and approved. |
| BUG2-51 | S2 | pipeline | an idea bank that fails to load degrades to no memory rather than aborting the brief | A read error on the idea bank aborts the whole brief instead of running without memory and recording the error. |
| BUG2-52 | S2 | pipeline | duplicate formats in the request are deduplicated so creative ids stay unique | formats: ['story','story'] produces two creatives with the same id, which collide in the review queue and the launch plan. |
| BUG2-53 | S2 | pipeline | a selectCount of 0 stops cleanly at the ideas stage | Because selectIdeas returns an idea for count 0, the pipeline continues instead of stopping at ideas. |
| BUG2-55 | S2 | infra | every Edge Function the HTTP nodes and cron jobs call exists in supabase/functions | The migration schedules meta-insights-sync and idea-bank-performance, neither of which exists in supabase/functions. |
| BUG2-57 | S2 | web | a note typed for one gate is not attached to a decision on another gate | The decision note survives switching gates, so a note written about ideas is saved against the copy decision. |
| BUG2-01 | S3 | brief | a typo in an optional field name is reported rather than silently dropping the setting | Zod strips unknown keys, so a misspelled optional field (matchfunding) vanishes silently and the strategist never learns why match funding is missing from every output. |
| BUG2-05 | S3 | statics | an empty font family falls back to a usable font in the creative, not font-family=\ | An empty fontFamily renders font-family="" in every SVG and the rasteriser falls back to whatever font it finds. |
| BUG2-12 | S3 | config | LLM_PROVIDER with surrounding whitespace (as .env files often have) is accepted | 'LLM_PROVIDER=anthropic ' (trailing space from a .env file) is rejected as an unknown provider. |
| BUG2-13 | S3 | config | LLM_PROVIDER=anthropic without a key fails with a message naming ANTHROPIC_API_KEY | The Anthropic provider constructs without a key and only fails on the first request, after the operator has waited for the pipeline to start. |
| BUG2-14 | S3 | cost | formatUsd never prints NaN or negative zero | A NaN cost renders as '$NaN' in review queues and summaries. |
| BUG2-18 | S3 | ideas | a count of 0 is rejected clearly rather than failing schema validation deep in the provider | ideaCount 0 fails deep inside the provider with a schema message rather than a validation error naming the option. |
| BUG2-20 | S3 | copy | a leads campaign does not ask people to donate | A leads/sign-up campaign gets 'Donate today' primary texts next to a SIGN_UP button. |
| BUG2-21 | S3 | copy | duplicate variants in a pack are collapsed so Meta does not see the same ad twice | Identical headlines survive validation, so the launch plan can create two identical ads. |
| BUG2-27 | S3 | landing | variant B is not indexable as a duplicate of variant A | Both A/B variants are index,follow with no canonical, so search engines see duplicate pages. |
| BUG2-29 | S3 | video | a 120-character word is hard-broken so no caption line exceeds the width | A single very long token (a URL, a hashtag) is kept on one line and overflows the frame. |
| BUG2-35 | S3 | media buyer | pipes and newlines in entity names do not break the markdown table | Ad set names containing | or line breaks split the recommendations table into extra cells and rows. |
| BUG2-41 | S3 | toast | a ranking over a window with no spend says so instead of ending with an empty list | A ranking with no eligible clients ends with 'in the window: .' |
| BUG2-42 | S3 | toast | 'biggest spend increase' asks for the up direction on spend, not a ROAS drop | 'increase' is not recognised as the up direction, so the question is answered with the biggest drop. |
| BUG2-43 | S3 | toast | an insight with an unknown severity from a stale file renders a neutral pill, never the literal 'undefined' | An unexpected severity value renders class="pill undefined" in the dashboard. |
| BUG2-46 | S3 | reporting | the change column shows n/a, not 0%, when there is no previous period | With no previous period the report shows '0%' change where the dashboard shows 'n/a'. |
| BUG2-48 | S3 | comms | an empty sender name still produces a proper greeting | An email with no sender name produces a reply starting 'Hi ,'. |
| BUG2-54 | S3 | cli | a flag given without a value is an error, not a silent fallback to the sample file | 'npm run demo -- --brief' with no path silently falls back to the sample brief. |
| BUG2-56 | S3 | config | every environment variable the code reads is documented in .env.example | FFMPEG_PATH, OUT_DIR, MOCK_SEED, IMAGE_PROVIDER_URL/KEY and the routing variables are read by the code but not all appear in .env.example. |
| BUG2-58 | S3 | web | character counts in the copy preview count what a person sees, so an emoji is one character | The copy preview shows UTF-16 lengths, so an emoji counts as two and disagrees with the guardrail limits. |
| BUG2-59 | S3 | web | zero briefs shows an explanation instead of a blank card | An agent run with no clients renders an empty 'Morning briefs' card with no explanation. |

## Scenarios that passed first time (74)

The remaining scenarios in the same files passed without changes and now stand as regression guards: boundary limits on every character cap, grapheme-aware emoji lengths, leap-day and BST date arithmetic, degenerate caption windows, clips shorter than their beat, duplicate selections, quote-laden brand names in drawtext, work directories with spaces, executor edge cases (empty plans, concurrency 0/NaN, failFast off, zero clips), execution policy (zero 'from', stale approvals, rejecting ads clients), Meta payload integrity (budget sums, UTM encoding, ad→ad set→creative references), the demo dataset at both ends of its date range, metric windows of zero or negative length, Toast/agent agreement on tracking breaks across a week, 10,000-character emails, decimal returns in replies, signatures that mention invoicing, pause requests escalated to humans, n8n connection integrity and secret hygiene, README script references, idea-bank bookkeeping, and the app shell's missing-data message.

## Fix order

1. **S1 first** (12): the synthetic-testimonial gate, Gift Aid eligibility in copy and landing checks, the pause-vs-trim contradiction, budget step bounds, age-range parsing, Meta minimum budgets and date ordering in the launch bundle, soft-hyphen/zero-width normalisation and the 0044 prefix in guardrails, and the zero-donation client report.
2. **S2** (27): pipeline resilience (empty script requests, image/idea-bank failures, duplicate formats, selectCount 0), schema-safe mocks (stat value, short case study, short title), guardrail false positives (years, number words, shorthand, blank/padded avoid words), Toast name matching, NaN in the one-day dashboard, SRT CRLF and filter-path escaping, date rollover, brief validation (blank strings, ISO dates, end after start), the missing Edge Functions and the note leak in the review queue.
3. **S3** (20): wording and polish.

Fixing follows the first pass's rule: product code changes only; these tests are not edited except to remove the `it.fails` marker once a defect is closed.

# Production risk catalogue

How real users, real model output and real ad data can break this system, and the test that proves each case. Written before fixing anything: the point of this pass is to know where the edges are. Every scenario below has a test in `tests/edge-cases/` or `web/src/views/edge.test.tsx`. Scenarios the current code already handles are listed as **covered**. Scenarios it does not are **known bugs**: their tests are written to assert the behaviour we want and marked `it.fails("[BUG-nn] …")`, so the suite stays green today and a fix makes the marker fail, prompting its removal.

Run just this layer with:

```bash
npx vitest run tests/edge-cases web/src/views/edge.test.tsx
```

Result at time of writing: 120 scenarios, 76 covered, 44 known-failing across 41 distinct bugs.

---

## Severity key

| Level | Meaning |
|---|---|
| **S1 · money or trust** | Could spend client money wrongly, send a wrong figure to a client, or publish something unsafe |
| **S2 · wrong output shipped** | A reviewer could approve something broken because the tooling did not flag it |
| **S3 · crash or dead end** | Pipeline or UI fails hard, or an operator is left with a stack trace |
| **S4 · quality and polish** | Degrades output or review experience, no direct harm |

---

## A · Brief input (what a strategist types)

| # | Scenario | Status |
|---|---|---|
| A1.1 | Missing required fields fail with a readable Zod error | covered |
| A1.2 | Zero, negative or string amounts and budgets rejected | covered |
| A1.3 | Invalid website URL and 3-digit hex colours rejected | covered |
| A1.4 | Minimal brief (one tier, no objections, no match, no deadline, no charity number) parses with defaults | covered |
| A1.5 | Whole pipeline completes on the minimal brief | **BUG-01** S3 |
| A2.1 | Client name and campaign containing `<script>`, quotes, ampersands and emoji are escaped in SVG and HTML | covered |
| A2.2 | Emoji in copy does not crash limit checks | covered (but see BUG-21) |
| A2.3 | Hostile names produce filesystem-safe ids and file names | covered |
| A3.1 | Decimal and seven-figure amounts format correctly | **BUG-02** S4 |
| A3.2 | Six tiers (schema max) render a valid form | covered |
| A3.3 | Seven tiers fail clearly at the landing spec rather than silently | covered |
| A3.4 | One-word impact line still yields a valid landing spec | **BUG-01** S3 |
| A3.5 | Very long client and campaign names keep creatives inside the canvas | **BUG-03** S2 (and BUG-13) |
| A3.6 | Over-long creative seeds degrade to warnings, never blocked scripts | covered |
| A3.7 | Banned words that are regex metacharacters do not throw | covered |

## B · Guardrails (last line before a human)

| # | Scenario | Status |
|---|---|---|
| B1.1 | Claim variants with different casing and double spaces | **BUG-14** S2 |
| B1.2 | Guilt framing in its common phrasings | covered |
| B1.3 | UK mobile in every spacing; freephone and landline numbers | **BUG-15** S2 (mobiles covered; 0800/landline not) |
| B1.4 | Curly-quoted placeholders, `{{ }}`, single-brace `{name}`, "goes here" | **BUG-16** S2 (brackets and double braces covered) |
| B1.5 | Invented statistics as `4k`, `1.2m`, "nine in ten" | **BUG-17** S1 |
| B1.6 | A number not adjacent to a unit word ("42,000 older people") escapes the fact check | **BUG-18** S1 |
| B2.1 | Numbers inside URLs, dates and times are not flagged | covered |
| B2.2 | Social handles are not treated as email | covered |
| B2.3 | Banned words respect word boundaries | covered |
| B2.4 | Stage directions like `[music swells]` are flagged as placeholders in scripts | **BUG-19** S4 |
| B2.5 | Standard Gift Aid declaration passes clean | covered |
| B2.6 | "We cannot guarantee" is hard-blocked | **BUG-20** S4 |
| B3.1 | 100 KB of text checks in under 500 ms | covered |
| B3.2 | Punctuation-only and control-character text | covered |
| B3.3 | Character limits count UTF-16 units, not graphemes (emoji count double) | **BUG-21** S4 |
| B3.4 | `maxChars: 0` blocks everything instead of meaning "no limit" | **BUG-22** S4 |

## C · Static creative renderer

| # | Scenario | Status |
|---|---|---|
| C1.1 | 90-character headline on landscape never overlaps the CTA | covered |
| C1.2 | 90-char headline plus 140-char subline is flagged, not silently overlapped | covered |
| C1.3 | 12-character stat value (`£1,000,000.0`) overflows the canvas | **BUG-12** S2 |
| C1.4 | 40-char badge and 30-char CTA fit without touching the logo | covered |
| C2.1 | 60-character brand name pushes the wordmark off the left edge | **BUG-13** S2 |
| C2.2 | Light-on-light palette blocked; mid-grey warns | covered |
| C2.3 | Accent equal to text colour flags the CTA | covered |
| C2.4 | Quoted font-family escaped in SVG attributes | covered |
| C3.1 | Malformed SVG returns null from the rasteriser | covered |
| C3.2 | Emoji headline rasterises | covered |

## D · Scripts and video

| # | Scenario | Status |
|---|---|---|
| D1.1 | Unsupported target duration (45s) throws a TypeError instead of a clear error | **BUG-09** S3 |
| D1.2 | A beat with 0 seconds passes validation | **BUG-32** S2 |
| D1.3 | Newlines and double spaces in voiceover time correctly | covered |
| D2.1 | A single over-long word is never dropped | covered |
| D2.2 | Start after end yields monotonic cues | covered |
| D2.3 | Blank lines inside voiceover never terminate an SRT cue early | covered |
| D2.4 | `wrapLines` never returns an empty line | covered |
| D3.1 | Clip selection past the end of a clip yields a negative trim | **BUG-33** S3 |
| D3.2 | Unknown clip id falls back to a text card | covered |
| D3.3 | Zero-length or overlapping transcript segments | covered |
| D3.4 | File names with spaces, apostrophes and unicode pass through verbatim | covered |
| D3.5 | Newlines inside drawtext are not escaped | **BUG-34** S3 |
| D3.6 | A music mood that slugs to nothing produces `music-.m4a` | **BUG-35** S4 |
| D3.7 | Gap-filler text cards are dropped from the ffmpeg plan, so a beat with no footage disappears from the cut | **BUG-36** S2 |

## E · Media buyer agent (moves money)

| # | Scenario | Status |
|---|---|---|
| E1.1 | Duplicate daily rows from a re-synced day double-count spend and conversions | **BUG-28** S1 |
| E1.2 | Rows dated after as-of are ignored | covered |
| E1.3 | Ad set with no rows: no NaN, no metric-based recommendations | covered |
| E1.4 | As-of before the data starts: empty run, no crash | covered |
| E1.5 | Paused ad set never receives budget changes | covered |
| E2.1 | Nonsense thresholds rejected by the config schema | covered |
| E2.2 | A £1 budget step that rounds to no change is still proposed | **BUG-29** S4 |
| E2.3 | Target CPA of zero does not flag every ad as dead | covered |
| E2.4 | Unknown autonomy level is silently treated as assist | **BUG-10** S1 |
| E2.5 | Approval id not in today's run is ignored | covered |
| E2.6 | Yesterday's approval does not execute today's regenerated recommendation | covered |
| E3.1 | Ads client throwing marks the item failed and continues | covered |
| E3.2 | A hanging ads client blocks the daily run forever | **BUG-30** S1 |
| E3.3 | Two runs on the same day: identical ids, no duplicate actions | covered |
| E4.1 | Ad set names containing Slack control sequences (`<!channel>`) pass into alerts | **BUG-31** S2 |

## F · Toast (read by non-technical people)

| # | Scenario | Status |
|---|---|---|
| F1.1 | Insights on an empty account | covered |
| F1.2 | Dashboard with no metrics shows no NaN or Infinity | covered |
| F1.3 | Two days of history shows "+100%" against an empty previous period | **BUG-37** S2 |
| F1.4 | Anomaly detection with too little history or a flat zero series | covered |
| F1.5 | Metric rows for a deleted ad aggregate under the id | covered |
| F2.1 | Empty or whitespace question gets the help answer | covered |
| F2.2 | "top 0 clients" / "top 500 clients" fails schema validation instead of clamping | **BUG-38** S3 |
| F2.3 | 5,000-character question | covered |
| F2.4 | Client names matched case-insensitively and with possessives | covered |
| F2.5 | Two clients in one question silently picks the first | **BUG-39** S4 |
| F2.6 | HTML in a question is escaped in the static dashboard | covered |
| F2.7 | "last 90 days" is capped to the data held | covered |
| F2.8 | Hostile question cannot precede the instructions in the intent prompt | covered |
| F3.1 | Client names from the ad account are embedded unescaped in the dashboard's JSON script block | **BUG-40** S2 |

## G · Landing pages and pipeline resilience

| # | Scenario | Status |
|---|---|---|
| G1.1 | Non-Gift-Aid brief renders no declaration and passes | covered |
| G1.2 | Charity number is guaranteed by the footer even if the model omits it from trust signals | covered |
| G1.3 | Form action pointing at a third-party domain is not flagged | **BUG-23** S1 |
| G1.4 | FAQ answers with invented statistics are flagged | covered |
| G1.5 | `javascript:` website URL accepted by the brief schema | **BUG-24** S1 |
| G2.1 | Provider error mid-pipeline surfaces with the task named | covered |
| G2.2 | A refusal is distinguishable from a network error | covered |
| G2.3 | Every idea on the same angle still yields a primary idea | covered |
| G2.4 | Every headline blocked stops the pipeline at copy with a reason | covered |
| G2.5 | Zero creative formats crashes the static stage instead of skipping it | **BUG-25** S3 |
| G3.1 | A reviewer that throws loses all work done so far | **BUG-26** S3 |
| G3.2 | A rubber-stamp reviewer can approve a guardrail-blocked artefact | **BUG-27** S1 |

## H · Client comms, reports and CLI

| # | Scenario | Status |
|---|---|---|
| H1.1 | Complaint mixed with a results question is treated as a complaint | covered |
| H1.2 | Prompt injection in an email does not change facts or tier | covered |
| H1.3 | Email in another language is escalated | covered |
| H1.4 | Multi-line questions and markdown fences break the review markdown | **BUG-04** S4 |
| H1.5 | Zero-spend client gets "£0 raised" instead of a holding reply | **BUG-05** S1 |
| H1.6 | "we are cancelling" is not recognised as a complaint | **BUG-06** S2 |
| H2.1 | Zero-activity client report does not say the account was paused | **BUG-07** S2 |
| H2.2 | Audience names containing HTML are escaped in reports | covered |
| H2.3 | Verifier accepts any number whose digits appear in the as-of date | **BUG-08** S2 |
| H3.1 | Missing brief file exits non-zero naming the path | covered |
| H3.2 | Invalid LLM_PROVIDER names the allowed values | covered |
| H3.3 | `--seconds 45` crashes with a TypeError | **BUG-09** S3 |
| H3.4 | `--autonomy yolo` exits 0 and runs as assist | **BUG-10** S1 |
| H3.5 | `--as-of 08/11/2026` crashes with RangeError | **BUG-11** S3 |

## I · Web app

| # | Scenario | Status |
|---|---|---|
| I1.1 | localStorage throwing (private mode) still updates the screen | covered |
| I1.2 | Corrupt stored decisions are ignored | covered |
| I2.1 | Unknown preview kind renders the summary | covered |
| I2.2 | Preview with `data: null` crashes the review queue | **BUG-41** S3 |
| I2.3 | Toast view with zero clients | covered |
| I2.4 | Narrative with no paragraphs or actions | covered |
| I3.1 | Whitespace-only question is a no-op | covered |
| I3.2 | Twenty rapid questions keep the latest eight and stay responsive | covered |
| I3.3 | HTML in a question renders as text | covered |
| I3.4 | Double-clicking Approve records one decision | covered |

---

## Known bugs, ordered by severity

Fix direction is a note for the next phase, not a commitment to that exact change.

| Bug | Severity | Area | What happens | Fix direction |
|---|---|---|---|---|
| BUG-17 | S1 | guardrails | `4k`, `1.2m`, "nine in ten" are not treated as statistics | Extend the stat pattern to k/m/bn suffixes and spelled-out ratios |
| BUG-18 | S1 | guardrails | Plain numbers not adjacent to a unit word skip the allowed-facts check | Check every number with three or more digits (and any with a comma) against allowed facts |
| BUG-28 | S1 | agent | Re-synced duplicate rows double-count spend and conversions, moving budget on wrong numbers | Dedupe metrics by (date, adId) at ingest and in `buildWindows`; prefer last-write |
| BUG-10 | S1 | agent, CLI | Unknown autonomy string is accepted and silently behaves as assist | Validate with a Zod enum in `runMediaBuyerAgent` and the CLI |
| BUG-30 | S1 | agent | A hanging ads client blocks the daily run indefinitely | Wrap each execution in a timeout (e.g. 30 s) and record a failed action |
| BUG-23 | S1 | landing | A form posting to a third-party domain is not flagged | Check `form action` against the client's domain or an allow-list |
| BUG-24 | S1 | brief | `javascript:` and other non-http URLs pass the schema | Restrict `website` to http/https with a refinement |
| BUG-27 | S1 | pipeline | A reviewer can approve a guardrail-blocked artefact | Gate enforces `report.ok` before honouring an approval; blocked items can only be rejected or regenerated |
| BUG-05 | S1 | comms | A client with no data receives "£0 raised, 0x return" | Escalate performance/budget/reporting questions when spend is zero |
| BUG-14 | S2 | guardrails | Claim regexes miss double spaces | Use `\s+` between words in claim patterns |
| BUG-15 | S2 | guardrails | Freephone and landline numbers not detected | Add 0800/0808/03xx/01xx/02xx patterns |
| BUG-16 | S2 | guardrails | `{name}` and "goes here" placeholders not detected | Add single-brace and common placeholder phrases |
| BUG-12 | S2 | renderer | 12-character stat values overflow the canvas | Scale stat font to fit the content width |
| BUG-13 | S2 | renderer | Long brand names push the wordmark off the left edge | Shrink or truncate the wordmark to the available width |
| BUG-03 | S2 | ideas mock | Long brand names produce idea titles over the 80-char schema limit | Truncate every generated title and hook |
| BUG-32 | S2 | scripts | Zero-second beats pass validation | Validate `seconds > 0` per beat at runtime |
| BUG-36 | S2 | video | Text cards for beats without footage are dropped from the render plan | Render `text` track items that stand in for missing footage as cards (distinguish from overlays) |
| BUG-31 | S2 | agent | Slack control sequences in entity names reach alerts | Escape `<`, `>`, `&` and `<!…>` in Slack text |
| BUG-37 | S2 | Toast | Period deltas show "+100%" when the previous period is empty | Return `null` for deltas with no baseline and render "n/a" |
| BUG-40 | S2 | Toast | Client names are embedded unescaped in the dashboard's inline JSON | Escape `<`, `>`, `&` as `<` etc. when serialising into a script block |
| BUG-06 | S2 | comms | "cancelling" is not recognised as a complaint | Stem or broaden the complaint vocabulary |
| BUG-07 | S2 | reports | Zero-activity report reads as a normal week | Detect zero spend and write a "campaigns were paused" narrative |
| BUG-08 | S2 | reports | Date components make 11, 8 and 2026 "allowed" numbers | Match the as-of date as a whole token, not its parts |
| BUG-01 | S3 | landing mock | Minimal briefs produce a meta description under the 50-char schema minimum | Pad meta description from the key message; pipeline should surface schema errors as a blocked gate, not a thrown error |
| BUG-09 | S3 | scripts, CLI | Unsupported durations throw a TypeError | Validate against 15/30/60 in `buildMockScript` and the video CLI |
| BUG-11 | S3 | CLI | Wrong date format crashes with RangeError | Validate `--as-of` with a regex and a real-date check |
| BUG-33 | S3 | video | Selection past clip end yields a negative trim | Clamp `inSec` to `durationSec - minLen` and recompute |
| BUG-34 | S3 | video | Newlines in drawtext text are not escaped | Replace newlines with spaces or `\n` escapes |
| BUG-25 | S3 | pipeline | Zero creative formats crashes the static stage | Skip the stage when no formats are requested |
| BUG-26 | S3 | pipeline | A throwing reviewer loses all completed work | Catch reviewer errors, mark the gate pending with the error, return the package |
| BUG-38 | S3 | Toast | "top 0" / "top 500" fail schema validation | Clamp `limit` and `days` in the heuristic parser before validation |
| BUG-41 | S3 | web | Null preview data crashes the review queue | Guard every preview renderer with a null check and an empty state |
| BUG-02 | S4 | formatting | Large amounts render without thousands separators | Use locale formatting in `formatCurrency` |
| BUG-04 | S4 | comms | Multi-line questions break the review markdown | Quote every line of the question and escape fences |
| BUG-19 | S4 | guardrails | Stage directions flagged as placeholders in scripts | Scope the placeholder rule by artefact type or allow-list stage directions |
| BUG-20 | S4 | guardrails | "cannot guarantee" is hard-blocked | Downgrade negated guarantees to a warning |
| BUG-21 | S4 | guardrails | Length counted in UTF-16 units | Count graphemes with `Intl.Segmenter` |
| BUG-22 | S4 | guardrails | `maxChars: 0` blocks everything | Treat non-positive limits as unset |
| BUG-29 | S4 | agent | Budget steps that round to no change are proposed | Skip proposals where `from === to` |
| BUG-35 | S4 | video | Empty music slug yields `music-.m4a` | Fall back to `music-default` |
| BUG-39 | S4 | Toast | Two clients in one question silently picks the first | Detect multiple matches and answer with a comparison or ask which |

---

## What this pass did not cover

- Live model behaviour (needs an API key; `tests/live/` covers the happy path only).
- Supabase Row-Level Security and Edge Function auth (structural tests only; needs a Supabase project).
- Concurrency across machines (two schedulers running the agent at once): mitigated by idempotent ids and no-op clients, not proven.
- Meta Marketing API error semantics beyond "non-2xx": rate limits, partial batch failures and review holds.
- Rendering real creator footage with odd codecs, variable frame rates or rotation metadata.

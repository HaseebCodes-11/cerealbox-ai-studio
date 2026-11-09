# Implementation roadmap · first 90 days

Assumes a start on a Monday with access to True ROAS, Supabase, one Meta ad account in a sandbox, and two friendly clients who agree to be first. Order is driven by three questions: **where is the data already clean, who feels the win first, and what unblocks the rest?**

## Why this order

1. **Toast and the ads agent first.** They need no creative sign-off, the data already exists in True ROAS, and media buyers feel the win on day one. They also build the trust needed to let AI near brand work.
2. **Ideas and copy second.** Lowest production cost, highest leverage on everything downstream, and the review screen built here is reused by every later area.
3. **Statics and landing pages third.** They depend on approved copy and on brand kits per client.
4. **Scripts, UGC and editing last.** Highest vendor dependency and the most judgement calls about synthetic media; they should land once the review culture exists.

## Milestones

### First 2 weeks · "Toast you can ask"
| Deliverable | Dependency | Done when |
|---|---|---|
| Aggregation layer as SQL views / Edge Function over `ad_metrics_daily` | True ROAS schema access | Portfolio, client, ad-set figures match the existing True ROAS reports to the penny |
| Insights + narrative digest to Slack each weekday | Aggregation; Anthropic key | 5 digests sent; media buyers rate ≥ 4/5 usefulness |
| Ask Toast (6 intents) in True ROAS | Aggregation | 20 real questions answered; ≥ 80 percent rated correct |
| Ads agent in **assist** mode on 2 clients, dry run | Aggregation; per-client targets | Daily recommendations reviewed; recall of real incidents tracked |
| Migration `0001`, telemetry tables, eval harness in CI | Supabase | `npm test` and `npm run eval` green in CI on every PR |

### 30 days · "Brief in, copy out"
| Deliverable | Dependency | Done when |
|---|---|---|
| Brief form + `campaign_briefs` in True ROAS | Review screen design | 5 real briefs entered by the creative team |
| Idea generator with idea bank and novelty scoring | Briefs | 3 campaigns pick from AI shortlists; creative lead rates ≥ 2 of 10 ideas "would run" |
| Copy packs with guardrails and the review gate screen | Briefs; ideas | Copy for 3 campaigns live on Meta; zero compliance flags from clients |
| Ads agent to **copilot** (one-click approvals via Slack) for the 2 pilot clients | 30 days of assist with ≥ 70 percent accepted recommendations | First approved budget change executed via API with audit row |
| Cost dashboard (model spend per area per client) | Telemetry | Visible in True ROAS |

### 60 days · "Finished assets"
| Deliverable | Dependency | Done when |
|---|---|---|
| Brand kits per client (palette, fonts, logo, photo style, banned words) | Client services input | 10 clients onboarded |
| Static creative specs → template renders → QA → approval, with one image vendor | Copy; brand kits | 2 campaigns launched with AI-assembled statics; CTR within 10 percent of designer-made controls |
| Landing page specs → React template on Vercel with real donation form; A/B with UTM attribution | Copy; fundraising platform API | 2 live A/B tests measured in True ROAS |
| Ads agent on all clients in assist; copilot for any client with 30 days of acceptance | Agent telemetry | 30 clients covered; < 5 percent false-positive rate on incidents |
| Toast weekly client-facing report | Insights | 5 clients receiving automated reports |

### 90 days · "Video, carefully"
| Deliverable | Dependency | Done when |
|---|---|---|
| Script writing with validation, feeding the creative review screen | Copy pillars | Scripts used on 3 campaigns |
| UGC manifests with one real-creator partner and one avatar/voice vendor in sandbox; disclosure policy agreed with leadership | Scripts; vendor contracts | 2 real-creator videos and 2 synthetic explainers live; watch-through compared |
| Video editing rough cuts (transcribe → select → EDL → captions → render) in a worker | Footage pipeline; ffmpeg worker | 3 rough cuts delivered; editor time per video down ≥ 40 percent |
| Ads agent **autopilot** for 2 clients within caps | 60 days copilot with ≥ 80 percent acceptance; leadership sign-off | Budget moves executed automatically with zero cap breaches |
| Retrospective: evals, costs, what to kill | Everything | Written review; next-quarter plan |

## How success is measured

- **Time:** hours from brief to launch-ready pack (target: days → same day); editor hours per video; media buyer hours per client per week.
- **Quality:** share of generated variants surviving QA; gate rejection rate per area (falling); client compliance flags (zero).
- **Performance:** CTR/ROAS of AI-assisted creatives vs controls; conversion rate of A/B landing pages; incidents caught by the agent before a human noticed.
- **Trust:** recommendation acceptance rate per client (the gate for moving up the autonomy ladder).
- **Cost:** model spend per campaign and per client, tracked in the cost dashboard.

## Risks and how I would handle them

| Risk | Mitigation |
|---|---|
| Meta API changes or rate limits | All execution in one Edge Function with retries and batching; dry-run mode always available |
| A model update changes tone or breaks schemas | Pinned model id, eval gate in CI, provider switch is one variable |
| Clients uneasy about AI on their brand | Opt-in per client, human gate on everything brand-facing, disclosure policy written down |
| Synthetic media backlash | Never for testimonials; label it; measure it; be ready to turn it off per client |
| Over-automation | Autonomy ladder with caps; weekly review of auto-executed actions |

# Architecture · how this fits CerealBox's stack

## Runtime shape in production

```mermaid
flowchart TB
  subgraph Browser["True ROAS (React · Vite · TanStack · Tailwind · shadcn) on Vercel"]
    UI1[Brief form] --> UI2[Review queue: gates by area]
    UI3[Toast dashboard · Ask Toast]
    UI4[Agent recommendations · approvals]
  end
  subgraph Supabase
    DB[(Postgres: briefs · artefacts · review_gates · model_calls · agent_* · toast_* · idea_bank · ad_metrics_daily)]
    EF1[Edge Fn: run-pipeline-stage]
    EF2[Edge Fn: ads-agent-run / ads-agent-execute]
    EF3[Edge Fn: toast-insights]
    EF4[Edge Fn: meta-insights-sync]
    CRON[pg_cron]
    ST[(Storage: PNG · HTML · MP4)]
  end
  subgraph Vendors
    CL[Claude API]
    META[Meta Marketing API]
    IMG[Image model]
    AV[Avatar + voice]
    FF[ffmpeg worker]
  end
  N8N[n8n: Slack approvals · digests]
  Browser <--> DB
  Browser --> EF1
  EF1 --> CL
  EF1 --> IMG
  EF1 --> AV
  EF1 --> FF
  EF1 --> ST
  CRON --> EF2 & EF3 & EF4
  EF2 --> META
  EF3 --> CL
  EF4 --> META
  EF2 --> N8N
  EF3 --> N8N
  N8N --> EF2
```

- **The pipeline code in `src/` is plain TypeScript with no framework dependency**, so it runs unchanged in a Supabase Edge Function (Deno) or a Node worker. The CLI in `src/cli/` is just one host.
- **Secrets stay server-side.** Meta tokens and the Anthropic key live in Edge Function secrets. n8n calls Edge Functions with a service-role header; the browser never sees a vendor key.
- **Postgres is the queue.** A review gate row with `decision = 'pending'` is the work item; approving it (UI or Slack via n8n) triggers the next stage. No extra queue infrastructure until volume demands it.
- **Storage** holds renders; `artefacts.storage_path` points at them.

## Data model

See `supabase/migrations/0001_ai_studio_schema.sql`. Key tables:

| Table | Purpose |
|---|---|
| `campaign_briefs` | The single source of truth per campaign (JSON validated by `CampaignBriefSchema`) |
| `artefacts` | Every generated thing, by kind and version, with guardrail score and issues |
| `review_gates` | Every human decision: gate, risk, who, why, when |
| `model_calls` | Tokens, cost, latency, stop reason, schema validity per task |
| `agent_runs`, `agent_recommendations`, `agent_actions` | The ads agent's memory and audit trail; recommendation ids are idempotent per day |
| `toast_digests`, `toast_questions` | Daily digests; questions with thumbs up/down for evals |
| `idea_bank` | Every idea ever, with later performance, feeding novelty scoring |

Row-Level Security: agency staff (JWT `app_metadata.role` in staff/admin) see everything; client users see rows where `client_id` is in their `app_metadata.client_ids`.

## Scheduled jobs (pg_cron → Edge Functions)

| When | Job |
|---|---|
| 06:30 daily | Meta insights sync into `ad_metrics_daily` (True ROAS already has this) |
| 07:00 weekdays | Ads agent run at the configured autonomy level |
| 07:15 weekdays | Toast insights + narrative, stored as the digest |
| Sunday 02:00 | Idea bank performance refresh from ad metrics |

## n8n

Two exports in `automations/n8n/`:
- `toast-daily-digest.json`: schedule → Edge Function → Claude narrative → Supabase → Slack; critical insights page `#ads-alerts`.
- `ads-agent-approval.json`: webhook from the agent run → split → route by risk tier → escalate human items, one-click Slack approval for approve items → execute via Edge Function or mark rejected.

n8n is for human-facing glue. Anything that touches money or a vendor token is an Edge Function.

## Code layout in this repo

```
src/core        brief schema · LLM provider (mock/anthropic) · guardrails · review gates · audit · cost · ads data model
src/areas       one folder per area: types (zod) · generate (defineTask) · validate/checks · render
src/orchestrator the end-to-end pipeline with gates
src/evals       red team · scorecard · agent recall
src/cli         demo · toast · agent · eval
tests           vitest: 196 tests across core, every area, orchestrator, evals, automations, CLI
automations/n8n two importable workflows
supabase        migration with schema, RLS, pg_cron
samples         a charity brief and transcribed footage metadata
```

## Switching the model

```
LLM_PROVIDER=anthropic ANTHROPIC_MODEL=claude-opus-5-5 npm run demo
```

The Anthropic provider uses structured outputs (`betaZodOutputFormat`), adaptive thinking with a per-task effort level, prompt caching on the system prompt, and the server-side refusal fallback. Every output is re-validated against the task's Zod schema; refusals and truncation raise typed errors that the pipeline records and surfaces at the gate.

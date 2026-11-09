-- CerealBox AI Studio · Supabase schema
-- Extends True ROAS with the tables the nine workflows need. Everything is
-- tenant-scoped by client_id and protected by Row-Level Security so a client
-- user only ever sees their own briefs, assets and recommendations.

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";

-- ---------------------------------------------------------------------------
-- Briefs: the single object every workflow reads from
-- ---------------------------------------------------------------------------
create table if not exists campaign_briefs (
  id            text primary key,
  client_id     text not null,
  campaign_name text not null,
  objective     text not null check (objective in ('donations','regular_giving','leads','awareness')),
  brief         jsonb not null,                       -- validated against CampaignBriefSchema in the app
  status        text not null default 'draft' check (status in ('draft','in_review','approved','archived')),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Generated artefacts: ideas, copy, creatives, scripts, UGC manifests, EDLs,
-- landing page specs. One table, discriminated by kind, versioned per brief.
-- ---------------------------------------------------------------------------
create table if not exists artefacts (
  id             uuid primary key default gen_random_uuid(),
  brief_id       text not null references campaign_briefs(id) on delete cascade,
  client_id      text not null,
  kind           text not null check (kind in ('idea','copy_pack','creative_spec','creative_render','script','ugc_manifest','edl','landing_spec','landing_html','launch_plan')),
  version        int  not null default 1,
  parent_id      uuid references artefacts(id),      -- the idea a copy pack came from, etc.
  payload        jsonb not null,
  guardrail_score int,
  guardrail_issues jsonb not null default '[]'::jsonb,
  storage_path   text,                                -- PNG / HTML / MP4 in Supabase Storage
  created_at     timestamptz not null default now()
);
create index if not exists artefacts_brief_kind_idx on artefacts (brief_id, kind, version desc);

-- ---------------------------------------------------------------------------
-- Review gates: every human decision, who made it and why
-- ---------------------------------------------------------------------------
create table if not exists review_gates (
  id            uuid primary key default gen_random_uuid(),
  brief_id      text not null references campaign_briefs(id) on delete cascade,
  client_id     text not null,
  gate          text not null,                        -- ideas.select, copy.approve, ...
  area          text not null,
  risk          text not null check (risk in ('auto','approve','human')),
  artefact_id   uuid references artefacts(id),
  decision      text not null default 'pending' check (decision in ('pending','approved','rejected')),
  reviewer_id   uuid references auth.users(id),
  reason        text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists review_gates_pending_idx on review_gates (decision, created_at) where decision = 'pending';

-- ---------------------------------------------------------------------------
-- Model calls: cost and quality telemetry for every LLM invocation
-- ---------------------------------------------------------------------------
create table if not exists model_calls (
  id              bigint generated always as identity primary key,
  brief_id        text references campaign_briefs(id) on delete set null,
  client_id       text,
  area            text not null,
  task_name       text not null,                      -- ideas.generate, copy.generate, ...
  provider        text not null,
  model           text not null,
  input_tokens    int  not null,
  output_tokens   int  not null,
  cost_usd        numeric(10,6) not null,
  latency_ms      int,
  stop_reason     text,
  schema_valid    boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists model_calls_area_day_idx on model_calls (area, created_at);

-- ---------------------------------------------------------------------------
-- Media buyer agent
-- ---------------------------------------------------------------------------
create table if not exists agent_runs (
  id            uuid primary key default gen_random_uuid(),
  as_of         date not null,
  autonomy      text not null check (autonomy in ('assist','copilot','autopilot')),
  dry_run       boolean not null default true,
  config        jsonb not null,
  adsets_seen   int not null,
  created_at    timestamptz not null default now()
);

create table if not exists agent_recommendations (
  id              text primary key,                   -- rule:entity:date (idempotent per day)
  run_id          uuid not null references agent_runs(id) on delete cascade,
  client_id       text not null,
  rule            text not null,
  type            text not null,
  entity_level    text not null check (entity_level in ('ad','adset','campaign','client')),
  entity_id       text not null,
  entity_name     text not null,
  title           text not null,
  rationale       text not null,
  evidence        jsonb not null,
  risk            text not null check (risk in ('auto','approve','human')),
  confidence      numeric(3,2) not null,
  proposed_change jsonb,
  status          text not null default 'proposed' check (status in ('proposed','approved','rejected','executed','auto_executed','failed')),
  decided_by      uuid references auth.users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists agent_recs_client_status_idx on agent_recommendations (client_id, status, created_at desc);

create table if not exists agent_actions (
  id                 bigint generated always as identity primary key,
  recommendation_id  text not null references agent_recommendations(id) on delete cascade,
  dry_run            boolean not null,
  ok                 boolean not null,
  detail             text not null,
  meta_request       jsonb,                           -- what we sent to the Marketing API
  meta_response      jsonb,                           -- what came back
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Toast: daily digests and saved questions
-- ---------------------------------------------------------------------------
create table if not exists toast_digests (
  id          bigint generated always as identity primary key,
  as_of       date not null,
  insights    jsonb not null,
  narrative   jsonb not null,
  created_at  timestamptz not null default now(),
  unique (as_of)
);

create table if not exists toast_questions (
  id          bigint generated always as identity primary key,
  asked_by    uuid references auth.users(id),
  question    text not null,
  intent      jsonb not null,
  answer      jsonb not null,
  helpful     boolean,                                -- thumbs up/down feeds intent-parser evals
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Idea bank: every idea ever generated, so novelty scoring has history
-- ---------------------------------------------------------------------------
create table if not exists idea_bank (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  brief_id    text references campaign_briefs(id) on delete set null,
  angle       text not null,
  title       text not null,
  hook        text not null,
  concept     text not null,
  scores      jsonb not null,
  used        boolean not null default false,
  performance jsonb,                                  -- filled in later from ad metrics (ROAS of ads built from it)
  created_at  timestamptz not null default now()
);
create index if not exists idea_bank_client_idx on idea_bank (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security: agency staff see everything, client users see their client
-- ---------------------------------------------------------------------------
alter table campaign_briefs        enable row level security;
alter table artefacts              enable row level security;
alter table review_gates           enable row level security;
alter table model_calls            enable row level security;
alter table agent_runs             enable row level security;
alter table agent_recommendations  enable row level security;
alter table agent_actions          enable row level security;
alter table toast_digests          enable row level security;
alter table toast_questions        enable row level security;
alter table idea_bank              enable row level security;

create or replace function is_agency_staff() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') in ('staff','admin'), false);
$$;

create or replace function user_client_ids() returns text[]
language sql stable as $$
  select coalesce(array(select jsonb_array_elements_text(auth.jwt() -> 'app_metadata' -> 'client_ids')), '{}');
$$;

create policy briefs_read on campaign_briefs for select using (is_agency_staff() or client_id = any(user_client_ids()));
create policy briefs_write on campaign_briefs for all using (is_agency_staff()) with check (is_agency_staff());
create policy artefacts_read on artefacts for select using (is_agency_staff() or client_id = any(user_client_ids()));
create policy artefacts_write on artefacts for all using (is_agency_staff()) with check (is_agency_staff());
create policy gates_read on review_gates for select using (is_agency_staff() or client_id = any(user_client_ids()));
create policy gates_write on review_gates for all using (is_agency_staff()) with check (is_agency_staff());
create policy model_calls_staff on model_calls for all using (is_agency_staff()) with check (is_agency_staff());
create policy agent_runs_staff on agent_runs for all using (is_agency_staff()) with check (is_agency_staff());
create policy recs_read on agent_recommendations for select using (is_agency_staff() or client_id = any(user_client_ids()));
create policy recs_write on agent_recommendations for all using (is_agency_staff()) with check (is_agency_staff());
create policy actions_staff on agent_actions for all using (is_agency_staff()) with check (is_agency_staff());
create policy digests_staff on toast_digests for all using (is_agency_staff()) with check (is_agency_staff());
create policy questions_own on toast_questions for all using (is_agency_staff() or asked_by = auth.uid()) with check (is_agency_staff() or asked_by = auth.uid());
create policy idea_bank_read on idea_bank for select using (is_agency_staff() or client_id = any(user_client_ids()));
create policy idea_bank_write on idea_bank for all using (is_agency_staff()) with check (is_agency_staff());

-- ---------------------------------------------------------------------------
-- Cost visibility: spend per client, area and month straight from model_calls.
-- ---------------------------------------------------------------------------
create or replace view model_cost_monthly as
select
  client_id,
  area,
  date_trunc('month', created_at)::date as month,
  count(*)                               as calls,
  sum(input_tokens)                      as input_tokens,
  sum(output_tokens)                     as output_tokens,
  round(sum(cost_usd)::numeric, 4)       as cost_usd
from model_calls
group by client_id, area, date_trunc('month', created_at);

-- ---------------------------------------------------------------------------
-- Scheduled jobs (pg_cron). Edge Functions do the work; cron just triggers them.
-- Every function requires `Authorization: Bearer <FUNCTIONS_SHARED_SECRET>`; the deploy step stores that
-- secret as a database setting so the jobs can present it:
--   alter database postgres set app.functions_secret = '<same value as the FUNCTIONS_SHARED_SECRET function secret>';
--   alter database postgres set app.functions_url = 'https://<project-ref>.supabase.co/functions/v1';
-- ---------------------------------------------------------------------------
-- 06:30 daily: pull yesterday's Meta insights into ad_metrics_daily (True ROAS already has this sync).
select cron.schedule('meta-insights-sync', '30 6 * * *',
  $$ select net.http_post(url := current_setting('app.functions_url') || '/meta-insights-sync', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.functions_secret')), body := '{}'::jsonb); $$);

-- 07:00 weekdays: run the media buyer agent in the configured autonomy level and write recommendations.
select cron.schedule('ads-agent-daily', '0 7 * * 1-5',
  $$ select net.http_post(url := current_setting('app.functions_url') || '/ads-agent-run', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.functions_secret')), body := '{"autonomy":"copilot","dryRun":false}'::jsonb); $$);

-- 07:15 weekdays: compute Toast insights + narrative and store the digest (Slack post handled by n8n or the function).
select cron.schedule('toast-digest', '15 7 * * 1-5',
  $$ select net.http_post(url := current_setting('app.functions_url') || '/toast-insights', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.functions_secret')), body := '{"days":7}'::jsonb); $$);

-- Sunday 02:00: re-score idea_bank.performance from ad metrics so novelty + "what worked" improve over time.
select cron.schedule('idea-bank-performance', '0 2 * * 0',
  $$ select net.http_post(url := current_setting('app.functions_url') || '/idea-bank-performance', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.functions_secret')), body := '{}'::jsonb); $$);

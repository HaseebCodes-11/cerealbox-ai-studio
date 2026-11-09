# Edge Functions

Four Supabase Edge Functions (Deno) that host the pipeline in production. They import the TypeScript in `src/` directly: those modules are plain TS with no Node-only imports on the paths used here, and `deno.json` enables sloppy imports so the repo's extensionless imports resolve. Native-module stages (resvg for statics, ffmpeg for video) run in a Node worker instead.

| Function | Trigger | Does |
|---|---|---|
| `toast-insights` | pg_cron 07:15 weekdays; n8n digest flow | Loads the metrics window, computes insights and the Claude narrative, upserts `toast_digests` |
| `ads-agent-run` | pg_cron 07:00 weekdays | Runs the Media Buyer agent at the configured autonomy level, writes `agent_runs` / `agent_recommendations` / `agent_actions`, posts proposed items to the n8n approval webhook |
| `ads-agent-execute` | n8n approval flow; review screen | Executes one approved recommendation against the Meta Marketing API, records the action and outcome |
| `run-pipeline-stage` | Review screen (after a gate is approved) | Runs the ideas / copy / scripts / landing stage for a brief, stores artefacts and opens the next review gate |

Every function requires the service-role key as a bearer token: only pg_cron, n8n and the app's server side call them. Secrets (`ANTHROPIC_API_KEY`, `META_ACCESS_TOKEN`, `N8N_AGENT_WEBHOOK_URL`) live in function secrets, never in the browser or in n8n.

```bash
supabase functions deploy toast-insights ads-agent-run ads-agent-execute run-pipeline-stage
supabase secrets set ANTHROPIC_API_KEY=... META_ACCESS_TOKEN=... N8N_AGENT_WEBHOOK_URL=...
```

Local test with the mock provider:

```bash
LLM_PROVIDER=mock supabase functions serve ads-agent-run --env-file .env
```

These handlers are not executed by the repo's Vitest suite (it runs under Node); the suite checks their structure, and the pipeline code they call is what the 200+ tests cover.

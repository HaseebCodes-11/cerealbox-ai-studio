# CerealBox AI Studio

Submission for the **CerealBox Agency AI Automation & Creative Workflow Challenge** by Haseeb Metla.

One campaign brief flows through nine stages (ideas → copy → statics → scripts → UGC → video editing → landing pages → launch plan → ads agent, with Toast analysing what comes back). At every step: a typed schema, deterministic guardrails, a human review gate, and an audit trail with cost. This repo is a working prototype of that loop plus the written proposal for every area.

- **Proposal (start here):** [docs/SUBMISSION.md](docs/SUBMISSION.md)
- **One document per area:** [docs/areas/](docs/areas/)
- **Roadmap (2 weeks / 30 / 60 / 90 days):** [docs/ROADMAP.md](docs/ROADMAP.md)
- **20-minute demo script:** [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)
- **How it fits Supabase / React / Vercel / n8n:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Quick start

```bash
npm install
npm run verify        # typecheck + 196 tests + full demo + evals
```

Or step by step:

```bash
npm run demo          # brief → ideas, copy, creatives (PNG), scripts, UGC manifest, edit plan, landing pages, launch plan; Toast dashboard; agent run
npm run toast         # build out/toast/dashboard.html
npm run toast:ask -- "Which client had the biggest ROAS drop last week?"
npm run agent -- --autonomy autopilot --live
npm run eval          # guardrail red team · pipeline scorecard · agent scenario recall
npm test
```

Everything runs offline with a deterministic mock LLM provider, so results are reproducible and free. To use Claude:

```bash
cp .env.example .env   # set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY
LLM_PROVIDER=anthropic npm run demo
```

## What gets generated

`npm run demo` writes to `out/`:

| Path | Contents |
|---|---|
| `brief-…/01-ideas.md` | 10 ranked ideas (12 possible angles), shortlist with hooks and visual direction |
| `brief-…/02-copy.md` | Meta copy pack with character counts and guardrail notes |
| `brief-…/03-creatives/*.png` | Square, story and landscape statics rendered from specs |
| `brief-…/04-scripts.md` | Beat-by-beat scripts with timings and QA |
| `brief-…/05-ugc-manifest.json` | Persona, shot list, providers, disclosure, approval gates, cost |
| `brief-…/06-video/` | EDL, SRT captions, ffmpeg render plan, pacing report |
| `brief-…/07-landing/` | Variant A and B HTML, spec, A/B diff |
| `brief-…/08-launch-plan.json` | Campaign → ad sets → ads mapping creatives, copy and landing variants |
| `brief-…/09-review-gates.md`, `10-audit.json`, `SUMMARY.md` | Decisions, full audit, costs |
| `toast/dashboard.html` | KPIs, trends, client table, insights, Ask Toast, agent recommendations |
| `agent/` | Recommendations, Slack-formatted alerts, morning briefs |

## Design in one paragraph

AI proposes, code checks, humans decide. Every model call is a `defineTask` with a Zod schema (Claude structured outputs), a prompt and a deterministic mock. Guardrails (`src/core/guardrails.ts`) catch guarantees, cure claims, pressure language, placeholders, PII, banned brand words, limit breaches and statistics not in the brief. Review gates (`src/core/review.ts`) are auto / one-click approve / human; the pipeline stops at a pending gate. The ads agent uses seven deterministic rules and an autonomy ladder (assist → copilot → autopilot) with hard caps; the model writes the brief, never the decision. Toast's numbers come from a pure aggregation layer; the model narrates and translates questions into typed queries.

## Repo map

```
src/core          brief · llm (mock + anthropic) · guardrails · review · audit · cost · ads model
src/areas         ideas · copy · static · scripts · ugc · video · media-buyer · landing · toast
src/orchestrator  end-to-end pipeline with gates
src/evals         red team · scorecard · agent recall
src/cli           demo · toast · agent · eval
tests             vitest (196 tests)
automations/n8n   toast-daily-digest.json · ads-agent-approval.json
supabase          migrations/0001_ai_studio_schema.sql (tables, RLS, pg_cron)
samples           brief-winter-warmth.json · raw-clips.json
docs              SUBMISSION · areas/ · ROADMAP · DEMO_SCRIPT · ARCHITECTURE
```

## Honest limits

- Mock content templates are tuned to the sample fuel-poverty brief; with `LLM_PROVIDER=anthropic` the model writes for any brief.
- Image, avatar, voice and Meta API vendors are integrated as interfaces with mock implementations; live keys are configuration, not code changes, but they are not wired here.
- The ffmpeg render plan is generated and tested, not executed (no footage files in the repo).
- No live CerealBox systems or ad accounts were accessed; all data is synthetic.

Built with TypeScript, Zod, Vitest, the Anthropic TypeScript SDK, resvg, Chart.js. Node 20+.

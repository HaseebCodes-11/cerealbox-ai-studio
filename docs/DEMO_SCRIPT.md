# 20-minute walkthrough script

Before the call: `npm run demo:all` (writes `out/` for both briefs), `npm run video` (renders the MP4), then `npm run web` and open http://localhost:5173. Have `docs/SUBMISSION.md` open and the rendered MP4 ready to play.

## 0:00 – 2:00 · The idea in one slide
- Open `docs/deck.html` (arrow keys), slides 1-3: the picture, the three things on every arrow, the principles. Or show the ecosystem diagram in `docs/SUBMISSION.md`.
- "One brief flows through nine stages. At every arrow: a schema, deterministic guardrails, a human gate. AI proposes, code checks, humans decide on brand, money and people."
- "Everything you'll see runs offline with a deterministic mock so it's reproducible and free; switching to Claude is one environment variable and the code path is identical."

## 2:00 – 7:00 · Live: brief → launch-ready package
- Run `npm run demo` in the terminal (takes a few seconds). Narrate the output lines as they appear: ideas → copy → creatives → scripts → UGC → video → landing → Toast → agent → cost.
- Open `out/.../01-ideas.md`: "Twelve named angles, re-scored in code for novelty and brand fit. The creative lead picks; the model never picks for them."
- Open `02-copy.md`: point at the character counts and the guardrail note on "25%" being allowed because Gift Aid is statutory. "Every number has to be in the brief."
- Open the three PNGs: square, story, landscape. "The model wrote a spec; a template rendered it; contrast, coverage and Stories safe zones were checked before anyone looked."
- Open `04-scripts.md`: beat table with seconds. "Hook lands in three seconds; voiceover fits at 150 words per minute; a testimonial script is flagged for disclosure."
- Open `05-ugc-manifest.json`: "Persona, shot list, providers, cost: £350 real creator vs £25 synthetic. Testimonials are never synthetic; the system refuses."
- Open `06-video/captions.srt` and `render-plan.sh`: "Transcript-matched cuts, broadcast caption rules, an ffmpeg plan an editor can read."
- Open `variant-A.html` and `ab-diff.md`: "Spec-driven page: Gift Aid declaration, charity number, UTM passthrough, amounts match the ad. B changes one thing and says why."
- Open `09-review-gates.md`: "Seven gates, all approved by a policy reviewer here; in production this is a screen in True ROAS."

## 7:00 – 12:00 · Toast and the ads agent, in the React app
- Switch to the web app (`npm run web`): this is the AI Studio module inside True ROAS, same stack as yours: Vite, React, Tailwind, TanStack Query.
- **Toast tab**: KPIs with week-on-week deltas, spend vs revenue, client table vs targets, creative types, insights sorted by severity. Type a question into Ask Toast live.
- **Review queue tab**: every gate from the pipeline with its guardrail score; click through ideas, copy, the creative PNGs, scripts, the UGC manifest and the landing pages in iframes; approve one with a note. "In production this row is `review_gates` in Supabase and Approve calls the `run-pipeline-stage` Edge Function."
- **Ads agent tab**: the autonomy ladder with the current level highlighted, alerts, recommendations by risk tier, approve or reject, morning briefs.
- **Client reports tab**: pick a charity, show the weekly report with "All N figures verified against the data" in the footer; then the drafted replies: a performance question marked ready to send, the invoice question escalated to finance with a holding reply. "AI drafts, code verifies every number, a human sends."
- Mention the idea bank: "I ran the demo twice; the second run excluded last time's angles and marked down repeats. That is the memory that stops ideas going generic."
- Point at the critical insight: "Zero donations for three days despite 453 clicks. That's a tracking break, not a performance problem, and the agent suppresses every other signal on that ad set so nobody cuts budget for the wrong reason."
- Run `npm run toast:ask -- "Which client had the biggest ROAS drop last week?"` then `"Do video or static creatives perform better?"`. "The model turns the question into a typed query; code answers it; sources are listed. It can't make up a number."
- Run `npm run agent -- --autonomy autopilot --live`. Show: human-tier items untouched, approve-tier budget moves executed inside the 20 percent cap, the fatigued creative *not* auto-paused. "Autonomy is earned per client: assist, copilot, autopilot."
- Show `automations/n8n/ads-agent-approval.json` in n8n (import it) or just the Slack-approval node: "Human workflow lives in n8n; money lives in an Edge Function with the Meta token."

## 12:00 – 15:00 · Quality, maintenance, cost
- Play the rendered MP4 from `out/brief-2026-winter-warmth/06-video/render/`: real cuts from the clip selection, burned captions in the safe zone, music ducked under the voice, brand end card. "Synthetic stand-in footage, real pipeline: swap in the creator's files and the same plan runs."
- Run `npm run eval`: red team 20/20 across two briefs, scorecards complete, agent recall 100 percent with zero extra findings, judge: no rejects. "This runs in CI; a prompt or model change that regresses it doesn't merge."
- Run `npm test`: 262 tests across the pipeline and the React app. Mention the stubbed Anthropic provider tests (refusal, truncation, schema failure), the real ffmpeg render test, and that CI runs the same chain on every push with a live Claude smoke test when a key is present.
- Cost line from the demo: "$0.15 per campaign package, $0.02 per daily agent run at Opus list prices. Model cost is not the constraint; vendor media cost and people time are."
- `supabase/migrations/0001_ai_studio_schema.sql`: briefs, artefacts, review gates, model calls, agent tables, idea bank, RLS, four pg_cron jobs.

## 15:00 – 18:00 · Roadmap
- `docs/ROADMAP.md`: two weeks Toast + agent in assist; 30 days ideas and copy with the review screen and copilot; 60 days statics and landing pages on real templates; 90 days scripts, UGC and editing, autopilot for two clients.
- "Order is driven by where the data is already clean, who feels the win first, and what unblocks the rest."

## 18:00 – 20:00 · What I'd build next, and questions
- Internal assistant: Ask Toast that answers anything about any client.
- Client-comms drafts from the same guardrails.
- Close the loop: creative performance writes back into the idea bank automatically.
- Honest limits: offline content comes from brief seeds through templates, not from Claude; the image API, avatar/voice vendors and Meta API are adapters with mocks; video renders on synthetic stand-in footage; Meta autopilot is a throttled batch job.

## Likely questions and short answers
- **"Why not let the model decide budgets?"** Auditability and tuning. A media buyer can read and change a threshold; nobody can tune a paragraph.
- **"What if Claude changes?"** Pinned model id, provider abstraction, eval gate. Switch, run evals, compare, roll forward or back.
- **"Can clients see this?"** Row-Level Security keys everything by client; client users see their own briefs, assets and recommendations only.
- **"What did you use to build it?"** TypeScript, Zod, Vitest, the Anthropic SDK with structured outputs, resvg for rendering, ffmpeg for video, React/Vite/Tailwind/TanStack Query/Recharts for the app, n8n exports, a Supabase migration and Edge Functions. Claude Code as the pair programmer.
- **"Does it only work for this one charity?"** No: run `npm run demo -- --brief samples/brief-food-bank.json`. Same pipeline, a food-bank brief, every check passes; the brief carries the creative seeds and the brand.

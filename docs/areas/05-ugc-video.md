# 05 · AI UGC Video

**Brief question:** Can AI handle most or all of UGC production, from script to a usable influencer-style video?

## Honest position

Most of the **production process**, yes: scripting, casting direction, shot lists, voice, captions, versions per placement, QA. Most of the **presenter**, it depends: informational and explainer content works with today's avatar tools; **testimonials do not**, because a synthetic person telling a story as if it happened to them is misleading, and for charities trust is the product. So the system refuses to cast a synthetic presenter for testimonial scripts and routes them to real creators with an AI-generated brief, while allowing synthetic presenters for explainers with a disclosure label.

## Workflow

```mermaid
flowchart LR
  S[Approved script] --> P[Claude · persona casting]
  P --> M[Manifest: shots · voice · avatar · deliverables · disclosure · gates]
  M --> G1{{Persona approved}}
  G1 --> R[Renderer: real creator brief · or HeyGen/Synthesia + ElevenLabs]
  R --> G2{{Rough cut approved}}
  G2 --> F[Final + captions + per-placement exports]
  F --> G3{{Final approved}}
```

**Manifest** (`src/areas/ugc/types.ts`): persona, one shot per beat (camera, setting, action, dialogue, on-screen text, props, duration), voice and avatar provider settings, deliverables (9:16, 1:1, SRT), disclosure (AI-generated flag, label text, Meta AI-disclosure flag), approval gates, estimated cost and turnaround.

## AI vs human

| AI | Code | Human |
|---|---|---|
| Casts a persona the audience trusts (a daughter, a volunteer, never the person being helped) and explains why | Enforces "testimonial is never synthetic", sets providers and disclosure from the persona, blocks rendering until persona and rough cut gates are approved, costs and schedules | Approves persona, rough cut and final; chooses real creator vs synthetic per client policy |

## Tools and why

- **HeyGen / Synthesia** for avatars, **ElevenLabs** for voice: the `UgcRenderer` interface wraps them so we can switch vendors as quality moves.
- **Real creators** via a generated brief (PDF shot list + script + usage rights) when authenticity matters; the cost table (£350 vs ~£25-40 synthetic, 5 days vs 2 hours) makes the trade-off explicit per video.
- Burned-in captions by default; most feed video plays muted.

## In the prototype

- `src/areas/ugc/` · tests `tests/areas/ugc.test.ts` (gate order, synthetic refusal, renderer lifecycle)
- `npm run demo` → `out/<brief>/05-ugc-manifest.json`
- `MockUgcRenderer` simulates queued → rendering → done; live vendors are adapters.

## Improvements next

- Connect one avatar vendor and one voice vendor in a sandbox and measure watch-through vs real creators on a small spend.
- Creator marketplace integration for the real-creator path.
- Automatic variant generation (hook swaps, length cuts) from one approved render.

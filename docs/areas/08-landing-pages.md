# 08 · AI Landing Pages

**Brief question:** Can AI help create high-quality landing pages from a brief, concept or offer, including structure, copy, design and iteration?

## Position

Yes, with the same split as statics: **the model writes the page as a spec, a template renders it.** Design consistency, accessibility, compliance (Gift Aid declaration, charity number) and tracking (UTM passthrough) are then properties of the template, and iteration becomes an A/B spec diff rather than a redesign.

## Workflow

```mermaid
flowchart LR
  C[Idea + copy pack + brief] --> M[Claude · page spec A and B]
  M --> R[Renderer: HTML (prototype) / React template on Vercel (production)]
  R --> Q[Checks: 1 H1 · CTA above fold · alt text · amounts = tiers · Gift Aid · charity no. · UTM · placeholders · text guardrails]
  Q --> H{{Client services + client approve}}
  H --> D[Deploy variant A/B → launch plan maps ads to variants]
  D --> T[True ROAS measures conversion and avg gift per variant]
  T --> M
```

**Spec** (`src/areas/landing/types.ts`): title and meta description within SEO limits, hero (headline, subheadline, CTA, image prompt, alt), problem, impact tiers matching the offer exactly, proof points verbatim, story, FAQ built from the audience's objections, trust signals, donation form (amounts, default, one-off/monthly, Gift Aid), closing CTA, variant hypothesis.

## AI vs human

| AI | Code | Human |
|---|---|---|
| Writes every section in plain English, answers each objection in the FAQ, states the B hypothesis | Renders, checks structure/compliance/tracking, diffs A vs B | Approves, chooses the hypothesis to test, signs off compliance wording |

## Tools and why

- **React + Tailwind template on Vercel** in production (CerealBox's stack), with the fundraising platform's donation form embedded; the prototype renders self-contained HTML so it can be opened anywhere.
- **UTM passthrough** to the donation record so True ROAS attributes revenue to the ad and the variant.
- **Checks in code** because a missing Gift Aid line or a mismatched amount is a compliance and conversion failure that a reviewer should never have to catch by eye.

## In the prototype

- `src/areas/landing/` · tests `tests/areas/landing.test.ts`
- `npm run demo` → `out/<brief>/07-landing/variant-A.html`, `variant-B.html`, `ab-diff.md`
- Both variants pass every check; B changes only the headline and states the hypothesis.

## Improvements next

- Real donation form embed and a Supabase function recording variant + UTMs with the gift.
- Auto-stop rule for A/B tests at significance, reported in Toast.
- Section-level variants (story vs no story) once the headline test has learned something.

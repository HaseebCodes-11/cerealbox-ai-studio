import type { Client } from "../../core/brief";
import { formatCurrency } from "../../core/brief";
import { escapeHtml } from "../../core/text";
import type { LandingPageSpec } from "./types";

/**
 * Deterministic HTML renderer. No external CSS or JS so the page works
 * offline and the output is fully testable. In production the same spec
 * renders through a React template on Vercel with the real donation form
 * embedded; here the form posts to a placeholder action.
 */
export function renderLandingPage(spec: LandingPageSpec, client: Client, options: { formAction?: string } = {}): string {
  const b = client.brand;
  const money = (n: number) => formatCurrency(n, spec.form.currency);
  const formAction = options.formAction ?? "#donate";

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<meta name="description" content="${escapeHtml(spec.metaDescription)}">
<meta property="og:title" content="${escapeHtml(spec.hero.headline)}">
<meta property="og:description" content="${escapeHtml(spec.metaDescription)}">
<meta name="robots" content="index,follow">
<meta name="x-variant" content="${spec.variant}">
<style>
  :root { --primary:${b.primary}; --secondary:${b.secondary}; --accent:${b.accent}; --text:${b.text}; --bg:${b.background}; --font:${escapeHtml(b.fontFamily)}; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:var(--font); color:var(--text); background:var(--bg); line-height:1.5; }
  .wrap { max-width:1080px; margin:0 auto; padding:0 20px; }
  header.top { background:var(--secondary); color:#fff; padding:14px 0; }
  header.top .wrap { display:flex; justify-content:space-between; align-items:center; }
  .brand { font-weight:800; letter-spacing:.5px; }
  .hero { display:grid; grid-template-columns: 1.1fr .9fr; gap:32px; align-items:center; padding:48px 0; }
  @media (max-width:800px) { .hero { grid-template-columns:1fr; padding:28px 0; } }
  h1 { font-size:clamp(30px,4.5vw,48px); line-height:1.1; margin:0 0 14px; }
  .sub { font-size:18px; margin:0 0 22px; }
  .btn { display:inline-block; background:var(--primary); color:#fff; padding:14px 26px; border-radius:999px; font-weight:700; text-decoration:none; border:0; font-size:17px; cursor:pointer; }
  .btn.accent { background:var(--accent); color:var(--text); }
  .hero-img { background:var(--secondary); border-radius:16px; aspect-ratio:4/3; display:flex; align-items:center; justify-content:center; color:#fff; padding:16px; text-align:center; font-size:14px; }
  section { padding:40px 0; }
  section.alt { background:#fff; }
  h2 { font-size:clamp(24px,3vw,32px); margin:0 0 16px; }
  .tiers { display:grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .tier { background:#fff; border:2px solid var(--secondary); border-radius:14px; padding:18px; }
  .tier .amt { font-size:34px; font-weight:800; color:var(--primary); }
  .proof { display:grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap:14px; }
  .proof div { background:var(--bg); border-left:4px solid var(--accent); padding:12px 14px; border-radius:6px; }
  .story { background:var(--secondary); color:#fff; border-radius:16px; padding:28px; }
  .story p { font-size:18px; }
  details { background:#fff; border-radius:10px; padding:12px 16px; margin-bottom:10px; }
  summary { font-weight:700; cursor:pointer; }
  .trust { display:flex; flex-wrap:wrap; gap:10px; }
  .trust span { background:#fff; border:1px solid #ddd; border-radius:999px; padding:6px 12px; font-size:14px; }
  form.donate { background:#fff; border-radius:16px; padding:24px; border:2px solid var(--primary); max-width:520px; }
  .amounts { display:flex; flex-wrap:wrap; gap:10px; margin:12px 0; }
  .amounts label { border:2px solid var(--secondary); border-radius:10px; padding:10px 16px; cursor:pointer; font-weight:700; }
  .amounts input { display:none; }
  .amounts input:checked + span { color:var(--primary); }
  .freq label { margin-right:14px; }
  .giftaid { background:var(--bg); padding:12px; border-radius:10px; margin:14px 0; font-size:14px; }
  footer { padding:28px 0; font-size:13px; color:#555; }
</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="brand">${escapeHtml(client.name.toUpperCase())}</span><a class="btn accent" href="#donate">${escapeHtml(spec.hero.ctaLabel)}</a></div></header>

<main>
<section class="wrap hero">
  <div>
    <h1>${escapeHtml(spec.hero.headline)}</h1>
    <p class="sub">${escapeHtml(spec.hero.subheadline)}</p>
    <a class="btn" href="#donate" data-cta="hero">${escapeHtml(spec.hero.ctaLabel)}</a>
  </div>
  <div class="hero-img" role="img" aria-label="${escapeHtml(spec.hero.imageAlt)}">${escapeHtml(`[hero image] ${spec.hero.imagePrompt}`)}</div>
</section>

<section class="alt"><div class="wrap">
  <h2>${escapeHtml(spec.problem.heading)}</h2>
  <p>${escapeHtml(spec.problem.body)}</p>
</div></section>

<section><div class="wrap">
  <h2>What your gift does</h2>
  <div class="tiers">
    ${spec.impact.map((i) => `<div class="tier"><div class="amt">${money(i.amount)}</div><div>${escapeHtml(i.label)}</div></div>`).join("\n    ")}
  </div>
</div></section>

<section class="alt"><div class="wrap">
  <h2>Why trust ${escapeHtml(client.name)}</h2>
  <div class="proof">${spec.proof.map((p) => `<div>${escapeHtml(p.text)}</div>`).join("")}</div>
</div></section>

<section><div class="wrap story">
  <h2>${escapeHtml(spec.story.heading)}</h2>
  <p>${escapeHtml(spec.story.body)}</p>
  ${spec.story.attribution ? `<p><em>— ${escapeHtml(spec.story.attribution)}</em></p>` : ""}
</div></section>

<section class="alt" id="donate"><div class="wrap">
  <h2>${escapeHtml(spec.closingCta.headline)}</h2>
  <form class="donate" method="post" action="${escapeHtml(formAction)}" data-variant="${spec.variant}">
    <div class="freq">${spec.form.frequencies.map((f, i) => `<label><input type="radio" name="frequency" value="${f}"${i === 0 ? " checked" : ""}> ${f === "one-off" ? "Give once" : "Give monthly"}</label>`).join("")}</div>
    <div class="amounts">
      ${spec.form.amounts.map((a) => `<label><input type="radio" name="amount" value="${a}"${a === spec.form.defaultAmount ? " checked" : ""}><span>${money(a)}</span></label>`).join("\n      ")}
      <label><input type="radio" name="amount" value="other"><span>Other</span></label>
    </div>
    ${spec.form.giftAid ? `<div class="giftaid"><label><input type="checkbox" name="gift_aid" value="yes"> Yes, I am a UK taxpayer and I want ${escapeHtml(client.name)} to claim Gift Aid on this and any donation I make in the future or have made in the past 4 years. I understand that if I pay less Income Tax and/or Capital Gains Tax than the amount of Gift Aid claimed on all my donations in that tax year it is my responsibility to pay any difference.</label></div>` : ""}
    <input type="hidden" name="utm_source" value=""><input type="hidden" name="utm_medium" value=""><input type="hidden" name="utm_campaign" value=""><input type="hidden" name="utm_content" value=""><input type="hidden" name="variant" value="${spec.variant}">
    <button class="btn" type="submit" data-cta="form">${escapeHtml(spec.form.buttonLabel)}</button>
  </form>
</div></section>

<section><div class="wrap">
  <h2>Your questions</h2>
  ${spec.faq.map((f) => `<details><summary>${escapeHtml(f.question)}</summary><p>${escapeHtml(f.answer)}</p></details>`).join("\n  ")}
</div></section>

<section class="alt"><div class="wrap">
  <div class="trust">${spec.trust.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>
</div></section>
</main>

<footer><div class="wrap">${escapeHtml(client.name)}${client.charityNumber ? ` · Registered charity number ${escapeHtml(client.charityNumber)}` : ""} · <a href="${escapeHtml(client.website)}">${escapeHtml(client.website)}</a> · Variant ${spec.variant}</div></footer>

<script>
(function(){
  // Pass UTM parameters from the ad click through to the donation record.
  try {
    var params = new URLSearchParams(window.location.search);
    ['utm_source','utm_medium','utm_campaign','utm_content'].forEach(function(k){
      var el = document.querySelector('input[name="'+k+'"]'); if (el && params.get(k)) el.value = params.get(k);
    });
    var other = document.querySelector('input[name="amount"][value="other"]');
    if (other) other.addEventListener('change', function(){ var v = window.prompt('Enter an amount'); if (v && !isNaN(parseFloat(v))) { other.value = parseFloat(v).toFixed(2); } });
  } catch (e) {}
})();
</script>
</body>
</html>`;
}

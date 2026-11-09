import { describe, expect, it } from "vitest";
import { HttpImageProvider, MockImageProvider, abstractScene, buildMockSpec, checkCreative, getImageProvider, renderCreative, renderPng, textCoverage } from "../../src/areas/static";
import { runCampaignPipeline } from "../../src/orchestrator";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const brief = sampleBrief();
const palette = brief.client.brand;
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);

describe("MockImageProvider", () => {
  it("produces deterministic, canvas-sized SVG markup", async () => {
    const p = new MockImageProvider();
    const a = await p.generate({ prompt: "warm kitchen, hands around a mug", width: 1080, height: 1080, palette, seed: "x" });
    const b = await p.generate({ prompt: "warm kitchen, hands around a mug", width: 1080, height: 1080, palette, seed: "x" });
    const c = await p.generate({ prompt: "cold terrace street at dusk", width: 1080, height: 1920, palette, seed: "x" });
    expect(a.markup).toBe(b.markup);
    expect(a.markup).not.toBe(c.markup);
    expect(a.markup.startsWith("<g data-background=")).toBe(true);
    expect(a.markup).toContain('width="1080" height="1080"');
    expect(c.markup).toContain('height="1920"');
    expect(a.markup).toContain("feTurbulence");
    expect(a.provider).toBe("mock-image");
    expect(a.dataUri).toBeUndefined();
  });

  it("escapes the prompt it embeds as an attribute", () => {
    const markup = abstractScene({ prompt: `a "quoted" <prompt>`, width: 100, height: 100, palette });
    expect(markup).toContain("data-background=\"a &quot;quoted&quot; &lt;prompt&gt;\"");
  });
});

describe("renderer with a background", () => {
  it("places the image layer under the brand gradient, drops the placeholder label and still passes checks", async () => {
    const spec = buildMockSpec(brief, idea, copy, "square", 0);
    expect(spec.imageStyle).toBe("photo");
    const image = await new MockImageProvider().generate({ prompt: spec.imagePrompt, width: 1080, height: 1080, palette, seed: spec.id });
    const withBg = renderCreative(spec, palette, brief.client.name, { background: image.markup });
    const withoutBg = renderCreative(spec, palette, brief.client.name);
    expect(withBg.svg).toContain("data-background=");
    expect(withBg.svg).not.toContain("[photo]");
    expect(withoutBg.svg).toContain("[photo]");
    expect(withBg.svg.indexOf("data-background=")).toBeLessThan(withBg.svg.indexOf('fill="url(#g)"'));
    expect(withBg.textBoxes).toEqual(withoutBg.textBoxes);
    expect(textCoverage(withBg)).toBe(textCoverage(withoutBg));
    const report = checkCreative(withBg, palette, brief);
    expect(report.ok, report.issues.map((i) => i.message).join("; ")).toBe(true);
    const png = await renderPng(withBg.svg);
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(20_000);
  });

  it("ignores a background for flat-colour layouts", async () => {
    const statSpec = buildMockSpec(brief, sampleIdea(brief, "stat-led"), copy, "square", 0);
    expect(statSpec.imageStyle).toBe("flat-colour");
    const rendered = renderCreative(statSpec, palette, brief.client.name, { background: "<g data-background=\"x\"></g>" });
    expect(rendered.svg).not.toContain("data-background");
  });
});

describe("HttpImageProvider", () => {
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("posts the prompt and embeds the returned image", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ imageBase64: png1x1, mimeType: "image/png" }), { status: 200 });
    }) as typeof fetch;
    const p = new HttpImageProvider({ endpoint: "https://images.example/generate", apiKey: "k", fetchImpl, name: "test-images" });
    const image = await p.generate({ prompt: "warm kitchen", width: 1080, height: 1920, palette });
    expect(captured!.url).toBe("https://images.example/generate");
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(captured!.init.body as string)).toEqual({ prompt: "warm kitchen", width: 1080, height: 1920 });
    expect(image.dataUri).toBe(`data:image/png;base64,${png1x1}`);
    expect(image.markup).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(image.provider).toBe("test-images");
  });

  it("throws on HTTP errors and on empty responses", async () => {
    const bad = new HttpImageProvider({ endpoint: "x", fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch });
    await expect(bad.generate({ prompt: "p", width: 10, height: 10, palette })).rejects.toThrow(/500/);
    const empty = new HttpImageProvider({ endpoint: "x", fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await expect(empty.generate({ prompt: "p", width: 10, height: 10, palette })).rejects.toThrow(/no image/);
  });

  it("getImageProvider picks HTTP when configured, else mock", () => {
    expect(getImageProvider({}).name).toBe("mock-image");
    expect(getImageProvider({ IMAGE_PROVIDER_URL: "https://x" }).name).toBe("http-image");
  });
});

describe("pipeline with an image provider", () => {
  it("renders backgrounds for photo creatives and records them in the audit", async () => {
    const pkg = await runCampaignPipeline({ brief, provider: provider(), imageProvider: new MockImageProvider() });
    expect(pkg.status).toBe("complete");
    const photo = pkg.creatives.filter((c) => c.rendered.spec.imageStyle === "photo");
    expect(photo.length).toBeGreaterThan(0);
    for (const c of photo) expect(c.rendered.svg).toContain("data-background=");
    expect(pkg.creatives.every((c) => c.report.ok)).toBe(true);
    expect(pkg.audit.all().filter((e) => e.type === "render" && e.step.endsWith(":background"))).toHaveLength(photo.length);
  });
});

import { describe, expect, it } from "vitest";
import { parseBrief } from "../../src/core/brief";
import { LLMOutputError, type LLMProvider, type LLMResult, type LLMTask } from "../../src/core/llm";
import { PolicyReviewer, type ReviewDecision, type ReviewRequest, type Reviewer } from "../../src/core/review";
import { buildMockLandingSpec, checkLandingPage, renderLandingPage } from "../../src/areas/landing";
import { runCampaignPipeline } from "../../src/orchestrator";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

/**
 * Scenario group G: landing pages are public and legally sensitive; the
 * pipeline runs unattended. What happens when the model misbehaves half way
 * through, or a reviewer's screen throws?
 */
const brief = sampleBrief();
const idea = sampleIdea(brief);
const copy = sampleCopy(brief, idea);

describe("G1 · landing page compliance edge cases", () => {
  it("a brief that is not Gift Aid eligible renders no declaration and still passes", () => {
    const b = { ...brief, offer: { ...brief.offer, giftAidEligible: false } };
    const spec = buildMockLandingSpec(b, idea, copy, "A");
    const html = renderLandingPage(spec, b.client);
    expect(html).not.toContain("UK taxpayer");
    expect(checkLandingPage(spec, html, b).ok).toBe(true);
  });

  it("the model omitting the charity number from trust signals is caught only if the footer also lacks it", () => {
    const spec = { ...buildMockLandingSpec(brief, idea, copy, "A"), trust: ["Secure payments"] };
    const html = renderLandingPage(spec, brief.client);
    expect(checkLandingPage(spec, html, brief).ok).toBe(true);
    expect(html).toContain(brief.client.charityNumber!);
  });

  it.fails("[BUG-23] a form action pointing at a third-party domain is flagged", () => {
    const spec = buildMockLandingSpec(brief, idea, copy, "A");
    const html = renderLandingPage(spec, brief.client, { formAction: "https://evil.example/steal" });
    expect(checkLandingPage(spec, html, brief).issues.map((i) => i.rule)).toContain("form.action");
  });

  it("FAQ answers containing a model-invented statistic are flagged", () => {
    const spec = buildMockLandingSpec(brief, idea, copy, "A");
    spec.faq[0]!.answer = "Only 3% goes on admin, 97% reaches older people directly.";
    const report = checkLandingPage(spec, renderLandingPage(spec, brief.client), brief);
    expect(report.issues.filter((i) => i.rule === "facts.unverified").length).toBeGreaterThan(0);
  });

  it.fails("[BUG-24] a website URL with a javascript: scheme is rejected by the brief schema", () => {
    const raw = JSON.parse(JSON.stringify(brief));
    raw.client.website = "javascript:alert(1)";
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("G2 · the model misbehaves mid-pipeline", () => {
  const failingOn = (taskName: string, error: Error = new Error("503 upstream")): LLMProvider => ({
    name: "failing",
    async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
      if (task.name === taskName) throw error;
      return provider().run(task, input);
    },
  });

  it("a provider error at the copy stage surfaces as a rejected promise with the task named", async () => {
    await expect(runCampaignPipeline({ brief, provider: failingOn("copy.generate") })).rejects.toThrow(/503/);
  });

  it("a refusal is reported as an LLMOutputError the caller can distinguish from a network error", async () => {
    const refused = failingOn("scripts.generate", new LLMOutputError("Model declined task scripts.generate: policy", "scripts.generate"));
    await expect(runCampaignPipeline({ brief, provider: refused })).rejects.toBeInstanceOf(LLMOutputError);
  });

  it("when the model returns every idea on the same angle, selection still yields a primary idea and the pipeline completes", async () => {
    const sameAngle: LLMProvider = {
      name: "same-angle",
      async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
        const result = await provider().run(task, input);
        if (task.name === "ideas.generate") {
          const out = result.output as unknown as { ideas: Array<{ angle: string }> };
          out.ideas = out.ideas.map((i) => ({ ...i, angle: "contrast" }));
        }
        return result;
      },
    };
    const pkg = await runCampaignPipeline({ brief, provider: sameAngle });
    expect(pkg.ideas.primary).not.toBeNull();
    expect(pkg.status).toBe("complete");
  });

  it("when the model returns copy where every headline is blocked, the pipeline stops at copy with a reason instead of launching nothing", async () => {
    const badCopy: LLMProvider = {
      name: "bad-copy",
      async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
        const result = await provider().run(task, input);
        if (task.name === "copy.generate") {
          const out = result.output as unknown as { headlines: string[] };
          out.headlines = out.headlines.map(() => "We guarantee results [INSERT]");
        }
        return result;
      },
    };
    const pkg = await runCampaignPipeline({ brief, provider: badCopy });
    expect(pkg.status).toBe("blocked");
    expect(pkg.stoppedAt).toBe("copy");
    expect(pkg.gates.find((g) => g.gate === "copy.approve")?.reason).toMatch(/guardrails/);
    expect(pkg.launchPlan).toBeNull();
  });

  it.fails("[BUG-25] requesting zero creatives still produces a launch plan that marks creatives pending", async () => {
    const pkg = await runCampaignPipeline({ brief, provider: provider(), formats: [] });
    expect(pkg.status).toBe("complete");
    expect(pkg.launchPlan?.adsets.every((a) => a.ads.every((ad) => ad.creativeId === "pending"))).toBe(true);
  });
});

describe("G3 · reviewers misbehave", () => {
  it.fails("[BUG-26] a reviewer that throws does not lose the work done so far", async () => {
    class Boom implements Reviewer {
      readonly name = "boom";
      async review<T>(req: ReviewRequest<T>): Promise<ReviewDecision<T>> {
        if (req.gate === "static.approve") throw new Error("review screen crashed");
        return new PolicyReviewer().review(req);
      }
    }
    const result = await runCampaignPipeline({ brief, provider: provider(), reviewer: new Boom() }).catch((e: Error) => e);
    // Desired: a package with status awaiting_review/blocked at the failing gate, not a bare exception.
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.stoppedAt).toBe("static.approve");
      expect(result.copy).not.toBeNull();
    }
  });

  it.fails("[BUG-27] a reviewer approving an artefact the guardrails blocked is overridden", async () => {
    class RubberStamp implements Reviewer {
      readonly name = "rubber-stamp";
      async review<T>(req: ReviewRequest<T>): Promise<ReviewDecision<T>> {
        return { status: "approved", artefact: req.artefact, reviewer: this.name };
      }
    }
    const badCopy: LLMProvider = {
      name: "bad-copy",
      async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
        const result = await provider().run(task, input);
        if (task.name === "landing.spec") {
          const out = result.output as unknown as { hero: { headline: string } };
          out.hero.headline = "We guarantee your gift ends fuel poverty";
        }
        return result;
      },
    };
    const pkg = await runCampaignPipeline({ brief, provider: badCopy, reviewer: new RubberStamp() });
    // A hard guardrail block must not be approvable by a reviewer click.
    expect(pkg.landing.every((l) => l.report.ok)).toBe(false);
    expect(pkg.status).not.toBe("complete");
  });
});

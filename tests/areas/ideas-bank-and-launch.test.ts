import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileIdeaBank, InMemoryIdeaBank, previousIdeaTexts, recentlyUsedAngles, toBankEntries } from "../../src/areas/ideas";
import { buildMetaLaunchBundle, parseAgeRange, placementPositions } from "../../src/areas/media-buyer";
import { buildLaunchPlan, runCampaignPipeline } from "../../src/orchestrator";
import { provider, sampleBrief, sampleCopy, sampleIdea } from "../helpers";

const brief = sampleBrief();

describe("idea bank", () => {
  it("second run for the same client remembers the first: repeats lose novelty and recent angles rotate out", async () => {
    const bank = new InMemoryIdeaBank();
    const first = await runCampaignPipeline({ brief, provider: provider(), ideaBank: bank, today: "2026-11-01" });
    expect(bank.entries).toHaveLength(first.ideas.ranked.length);
    expect(bank.entries.filter((e) => e.selected)).toHaveLength(first.ideas.selected.length);

    const second = await runCampaignPipeline({ brief, provider: provider(), ideaBank: bank, today: "2026-11-08" });
    const firstAngles = new Set(first.ideas.selected.map((i) => i.angle));
    // The angles selected last time are excluded from generation this time.
    for (const idea of second.ideas.ranked) expect(firstAngles.has(idea.angle), idea.angle).toBe(false);
    // Any idea whose text overlaps a stored one is marked down for novelty.
    const stored = new Set(bank.entries.slice(0, first.ideas.ranked.length).map((e) => e.title));
    const repeated = second.ideas.ranked.filter((i) => stored.has(i.title));
    const firstById = new Map(first.ideas.ranked.map((i) => [i.title, i]));
    for (const r of repeated) expect(r.scores.novelty).toBeLessThan(firstById.get(r.title)!.scores.novelty);
    expect(second.audit.byType("note").some((n) => n.step === "bank")).toBe(true);
    expect(bank.entries).toHaveLength(first.ideas.ranked.length + second.ideas.ranked.length);
  });

  it("does not bleed between clients", async () => {
    const bank = new InMemoryIdeaBank();
    await runCampaignPipeline({ brief, provider: provider(), ideaBank: bank });
    const other = { ...brief, id: "other", client: { ...brief.client, id: "someone-else" } };
    const run = await runCampaignPipeline({ brief: other, provider: provider(), ideaBank: bank });
    expect(run.audit.byType("note").some((n) => n.step === "bank")).toBe(false);
    expect(await bank.load("someone-else")).toHaveLength(run.ideas.ranked.length);
  });

  it("file bank persists across instances and tolerates a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbx-bank-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "bank.json");
    const a = new FileIdeaBank(path);
    const ranked = (await runCampaignPipeline({ brief, provider: provider() })).ideas;
    await a.save(toBankEntries(ranked.ranked, ranked.selected, "hearthline", brief.id, "2026-11-01"));
    const b = new FileIdeaBank(path);
    expect(await b.load("hearthline")).toHaveLength(ranked.ranked.length);
    expect(await b.load("nobody")).toEqual([]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{not json");
    expect(await new FileIdeaBank(path).load("hearthline")).toEqual([]);
  });

  it("helpers: previous texts and recently used angles", () => {
    const entries = [
      { clientId: "c", briefId: "b", ideaId: "1", angle: "contrast", title: "T1", hook: "H1", concept: "C1", total: 8, selected: true, createdOn: "2026-10-01" },
      { clientId: "c", briefId: "b", ideaId: "2", angle: "letter", title: "T2", hook: "H2", concept: "C2", total: 7, selected: false, createdOn: "2026-10-01" },
      { clientId: "c", briefId: "b2", ideaId: "3", angle: "question", title: "T3", hook: "H3", concept: "C3", total: 9, selected: true, createdOn: "2026-11-01" },
    ];
    expect(previousIdeaTexts(entries)[0]).toBe("T1 H1 C1");
    expect(recentlyUsedAngles(entries)).toEqual(["question", "contrast"]);
    expect(recentlyUsedAngles(entries, 1)).toEqual(["question"]);
  });
});

describe("Meta launch bundle", () => {
  const copy = sampleCopy(brief, sampleIdea(brief));
  const plan = buildLaunchPlan(brief, "idea-1", copy, ["creative-idea-1-square", "creative-idea-1-story", "creative-idea-1-landscape"]);
  const bundle = buildMetaLaunchBundle(plan, brief, copy, { adAccountId: "act_123", pageId: "page_1", pixelId: "px_1", landingBaseUrl: "https://give.hearthline.example/" });

  it("creates everything paused with budgets in pence and the right objective", () => {
    expect(bundle.campaign.objective).toBe("OUTCOME_SALES");
    expect(bundle.summary.allPaused).toBe(true);
    expect(bundle.adsets).toHaveLength(plan.adsets.length);
    expect(bundle.summary.dailyBudgetPence).toBe(Math.round(plan.adsets.reduce((s, a) => s + a.dailyBudgetGbp * 100, 0)));
    expect(bundle.adsets[0]!.daily_budget).toBe(Math.round(plan.adsets[0]!.dailyBudgetGbp * 100));
    expect(bundle.adsets[0]!.promoted_object).toEqual({ pixel_id: "px_1", custom_event_type: "PURCHASE" });
    expect(bundle.adsets[0]!.start_time).toBe("2026-12-01T00:00:00+00:00");
  });

  it("maps placements to positions and audiences to targeting", () => {
    const stories = bundle.adsets.find((a) => a.name.includes("Stories"))!;
    expect(stories.targeting.instagram_positions).toEqual(["story"]);
    const lookalike = bundle.adsets.find((a) => a.name.includes("Lookalike"))!;
    expect(lookalike.targeting.custom_audiences).toEqual([{ name: "Lookalike 1% previous donors" }]);
    const interests = bundle.adsets.find((a) => a.name.includes("Interests"))!;
    expect(interests.targeting.flexible_spec?.[0]?.interests[0]?.name).toBe(brief.audience.name);
    expect(interests.targeting.age_min).toBe(45);
    expect(interests.targeting.age_max).toBe(65);
    expect(placementPositions("Reels").instagram_positions).toEqual(["reels"]);
    expect(parseAgeRange(undefined)).toEqual([18, 65]);
    expect(parseAgeRange("16-70")).toEqual([18, 65]);
  });

  it("every ad references an existing ad set and creative; creatives carry copy, CTA, landing variant and UTMs", () => {
    const adsetRefs = new Set(bundle.adsets.map((a) => `adset:${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)}`));
    const creativeRefs = new Set(bundle.creatives.map((c) => c.creative_ref));
    expect(bundle.ads).toHaveLength(plan.adsets.reduce((s, a) => s + a.ads.length, 0));
    for (const ad of bundle.ads) {
      expect(adsetRefs.has(ad.adset_ref), ad.adset_ref).toBe(true);
      expect(creativeRefs.has(ad.creative_ref), ad.creative_ref).toBe(true);
      expect(ad.tracking_specs[0]!.fb_pixel).toEqual(["px_1"]);
    }
    const creative = bundle.creatives[0]!;
    expect(creative.object_story_spec.link_data.call_to_action.type).toBe("DONATE_NOW");
    expect(creative.object_story_spec.link_data.message).toBe(copy.primaryTexts[0]!.text);
    expect(creative.object_story_spec.link_data.link).toMatch(/^https:\/\/give\.hearthline\.example\/winter-warmth-appeal-2026-[ab]$/);
    expect(creative.url_tags).toContain("utm_term=lp-");
    expect(creative.object_story_spec.link_data.image_hash).toMatch(/^<upload:/);
    // Creatives are de-duplicated across ad sets that share creative, copy variant and landing variant.
    expect(bundle.creatives.length).toBeLessThan(bundle.ads.length);
  });

  it("uses lead and awareness objectives when the brief asks for them", () => {
    const leads = buildMetaLaunchBundle(buildLaunchPlan({ ...brief, objective: "leads" }, "i", copy, []), { ...brief, objective: "leads" }, copy, { adAccountId: "a", pageId: "p", pixelId: "x", landingBaseUrl: "https://x" });
    expect(leads.campaign.objective).toBe("OUTCOME_LEADS");
    expect(leads.adsets[0]!.optimization_goal).toBe("LEAD_GENERATION");
    const reach = buildMetaLaunchBundle(buildLaunchPlan({ ...brief, objective: "awareness" }, "i", copy, []), { ...brief, objective: "awareness" }, copy, { adAccountId: "a", pageId: "p", pixelId: "x", landingBaseUrl: "https://x" });
    expect(reach.adsets[0]!.optimization_goal).toBe("REACH");
    expect(reach.adsets[0]!.promoted_object).toBeUndefined();
  });
});

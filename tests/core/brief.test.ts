import { describe, expect, it } from "vitest";
import { CampaignBriefSchema, formatCurrency, parseBrief } from "../../src/core/brief";
import { sampleBrief } from "../helpers";

describe("CampaignBrief schema", () => {
  it("parses the sample brief and applies defaults", () => {
    const brief = sampleBrief();
    expect(brief.client.name).toBe("Hearthline");
    expect(brief.offer.donationTiers).toHaveLength(3);
    expect(brief.offer.giftAidEligible).toBe(true);
    expect(brief.client.region).toBe("UK");
    expect(brief.channels).toContain("meta_reels");
  });

  it("rejects an invalid brand colour", () => {
    const raw = JSON.parse(JSON.stringify(sampleBrief()));
    raw.client.brand.primary = "red";
    expect(() => parseBrief(raw)).toThrow(/hex colour/);
  });

  it("rejects a brief without donation tiers", () => {
    const raw = JSON.parse(JSON.stringify(sampleBrief()));
    raw.offer.donationTiers = [];
    expect(CampaignBriefSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects an unknown channel and objective", () => {
    const raw = JSON.parse(JSON.stringify(sampleBrief()));
    raw.channels = ["tiktok"];
    expect(CampaignBriefSchema.safeParse(raw).success).toBe(false);
    raw.channels = ["meta_feed"];
    raw.objective = "sales";
    expect(CampaignBriefSchema.safeParse(raw).success).toBe(false);
  });

  it("defaults constraints and references when omitted", () => {
    const raw = JSON.parse(JSON.stringify(sampleBrief()));
    delete raw.constraints;
    delete raw.references;
    const brief = parseBrief(raw);
    expect(brief.constraints).toEqual({});
    expect(brief.references).toEqual([]);
  });

  it("formats currency with the right symbol and precision", () => {
    expect(formatCurrency(30)).toBe("£30");
    expect(formatCurrency(30.5, "GBP")).toBe("£30.50");
    expect(formatCurrency(10, "USD")).toBe("$10");
    expect(formatCurrency(10, "EUR")).toBe("€10");
  });
});

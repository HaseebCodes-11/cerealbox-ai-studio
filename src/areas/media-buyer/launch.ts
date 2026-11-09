import type { CampaignBrief } from "../../core/brief";
import type { CopyPack } from "../copy/types";
import type { LaunchPlan } from "../../orchestrator/pipeline";

/**
 * Turn the launch plan into Meta Marketing API payloads. Everything is
 * created PAUSED: a human switches the campaign on in Ads Manager or via the
 * review screen after checking the preview. Budgets are in minor units
 * (pence) as the API expects; UTMs carry the ad name and landing variant so
 * True ROAS can attribute donations back to creative and page.
 */
export interface MetaLaunchOptions {
  adAccountId: string;
  pageId: string;
  pixelId: string;
  landingBaseUrl: string;
  instagramActorId?: string;
  countries?: string[];
}

export interface MetaCampaignPayload {
  name: string;
  objective: "OUTCOME_SALES" | "OUTCOME_LEADS" | "OUTCOME_AWARENESS";
  status: "PAUSED";
  special_ad_categories: string[];
  buying_type: "AUCTION";
}

export interface MetaAdSetPayload {
  name: string;
  campaign_ref: string;
  daily_budget: number; // pence
  billing_event: "IMPRESSIONS";
  optimization_goal: "OFFSITE_CONVERSIONS" | "LEAD_GENERATION" | "REACH";
  bid_strategy: "LOWEST_COST_WITHOUT_CAP";
  promoted_object?: { pixel_id: string; custom_event_type: "PURCHASE" | "LEAD" };
  targeting: {
    geo_locations: { countries: string[] };
    age_min: number;
    age_max: number;
    publisher_platforms: string[];
    facebook_positions?: string[];
    instagram_positions?: string[];
    custom_audiences?: Array<{ name: string }>;
    flexible_spec?: Array<{ interests: Array<{ name: string }> }>;
  };
  status: "PAUSED";
  start_time?: string;
  end_time?: string;
}

export interface MetaCreativePayload {
  name: string;
  object_story_spec: {
    page_id: string;
    instagram_actor_id?: string;
    link_data: {
      message: string;
      name: string;
      description: string;
      link: string;
      call_to_action: { type: string; value: { link: string } };
      image_hash: string; // filled after uploading the creative PNG
    };
  };
  url_tags: string;
  creative_ref: string;
}

export interface MetaAdPayload {
  name: string;
  adset_ref: string;
  creative_ref: string;
  status: "PAUSED";
  tracking_specs: Array<{ "action.type": string[]; fb_pixel: string[] }>;
}

export interface MetaLaunchBundle {
  adAccountId: string;
  campaign: MetaCampaignPayload;
  adsets: MetaAdSetPayload[];
  creatives: MetaCreativePayload[];
  ads: MetaAdPayload[];
  summary: { adsets: number; ads: number; dailyBudgetPence: number; allPaused: boolean };
}

export function buildMetaLaunchBundle(plan: LaunchPlan, brief: CampaignBrief, copy: CopyPack, options: MetaLaunchOptions): MetaLaunchBundle {
  const objective: MetaCampaignPayload["objective"] = plan.campaign.objective === "leads" ? "OUTCOME_LEADS" : plan.campaign.objective === "awareness" ? "OUTCOME_AWARENESS" : "OUTCOME_SALES";
  const optimisation: MetaAdSetPayload["optimization_goal"] = objective === "OUTCOME_LEADS" ? "LEAD_GENERATION" : objective === "OUTCOME_AWARENESS" ? "REACH" : "OFFSITE_CONVERSIONS";
  const [ageMin, ageMax] = parseAgeRange(brief.audience.ageRange);
  const campaignRef = `campaign:${slug(plan.campaign.name)}`;

  const campaign: MetaCampaignPayload = {
    name: plan.campaign.name,
    objective,
    status: "PAUSED",
    special_ad_categories: [],
    buying_type: "AUCTION",
  };

  const adsets: MetaAdSetPayload[] = [];
  const creatives: MetaCreativePayload[] = [];
  const ads: MetaAdPayload[] = [];
  const creativeRefs = new Map<string, string>();

  for (const adset of plan.adsets) {
    const adsetRef = `adset:${slug(adset.name)}`;
    const positions = placementPositions(adset.placement);
    adsets.push({
      name: adset.name,
      campaign_ref: campaignRef,
      daily_budget: Math.round(adset.dailyBudgetGbp * 100),
      billing_event: "IMPRESSIONS",
      optimization_goal: optimisation,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      ...(optimisation === "OFFSITE_CONVERSIONS" ? { promoted_object: { pixel_id: options.pixelId, custom_event_type: "PURCHASE" as const } } : optimisation === "LEAD_GENERATION" ? { promoted_object: { pixel_id: options.pixelId, custom_event_type: "LEAD" as const } } : {}),
      targeting: {
        geo_locations: { countries: options.countries ?? ["GB"] },
        age_min: ageMin,
        age_max: ageMax,
        publisher_platforms: ["facebook", "instagram"],
        ...positions,
        ...(adset.audience.toLowerCase().includes("lookalike") ? { custom_audiences: [{ name: adset.audience }] } : { flexible_spec: [{ interests: [{ name: brief.audience.name }] }] }),
      },
      status: "PAUSED",
      ...(plan.campaign.startDate ? { start_time: `${plan.campaign.startDate}T00:00:00+00:00` } : {}),
      ...(plan.campaign.endDate ? { end_time: `${plan.campaign.endDate}T23:59:59+00:00` } : {}),
    });

    for (const ad of adset.ads) {
      const primary = copy.primaryTexts.find((p) => p.variant === ad.primaryTextVariant) ?? copy.primaryTexts[0];
      const creativeKey = `${ad.creativeId}|${ad.primaryTextVariant}|${ad.landingVariant}`;
      let creativeRef = creativeRefs.get(creativeKey);
      if (!creativeRef) {
        creativeRef = `creative:${slug(creativeKey)}`;
        creativeRefs.set(creativeKey, creativeRef);
        const link = `${options.landingBaseUrl.replace(/\/$/, "")}/${slug(plan.campaign.name)}-${ad.landingVariant.toLowerCase()}`;
        creatives.push({
          name: `${ad.creativeId} · ${ad.primaryTextVariant} · LP ${ad.landingVariant}`,
          object_story_spec: {
            page_id: options.pageId,
            ...(options.instagramActorId ? { instagram_actor_id: options.instagramActorId } : {}),
            link_data: {
              message: primary?.text ?? "",
              name: ad.headline,
              description: copy.descriptions[0] ?? "",
              link,
              call_to_action: { type: copy.ctaButton, value: { link } },
              image_hash: `<upload:${ad.creativeId}.png>`,
            },
          },
          url_tags: `utm_source=meta&utm_medium=paid_social&utm_campaign=${encodeURIComponent(plan.campaign.name)}&utm_content={{ad.name}}&utm_term=lp-${ad.landingVariant}`,
          creative_ref: creativeRef,
        });
      }
      ads.push({
        name: ad.name,
        adset_ref: adsetRef,
        creative_ref: creativeRef,
        status: "PAUSED",
        tracking_specs: [{ "action.type": ["offsite_conversion"], fb_pixel: [options.pixelId] }],
      });
    }
  }

  return {
    adAccountId: options.adAccountId,
    campaign,
    adsets,
    creatives,
    ads,
    summary: {
      adsets: adsets.length,
      ads: ads.length,
      dailyBudgetPence: adsets.reduce((s, a) => s + a.daily_budget, 0),
      allPaused: [campaign, ...adsets, ...ads].every((x) => x.status === "PAUSED"),
    },
  };
}

export function placementPositions(placement: string): Pick<MetaAdSetPayload["targeting"], "facebook_positions" | "instagram_positions"> {
  switch (placement) {
    case "Stories":
      return { facebook_positions: ["story"], instagram_positions: ["story"] };
    case "Reels":
      return { facebook_positions: ["facebook_reels"], instagram_positions: ["reels"] };
    default:
      return { facebook_positions: ["feed"], instagram_positions: ["stream"] };
  }
}

export function parseAgeRange(range: string | undefined): [number, number] {
  const match = range?.match(/(\d{2})\s*-\s*(\d{2})/);
  if (!match) return [18, 65];
  const min = Math.max(18, Number(match[1]));
  const max = Math.min(65, Math.max(min, Number(match[2])));
  return [min, max];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

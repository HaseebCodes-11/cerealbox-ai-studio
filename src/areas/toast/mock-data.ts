import { addDays, dateRange, type AdMetricsDaily, type AdRef, type AdSetRef, type AdsDataset, type CampaignRef, type ClientRef } from "../../core/ads";
import { Rng } from "../../core/rng";
import { round2 } from "../../core/num";

/**
 * Seeded mock Meta Ads dataset for ~6 charity clients over 8 weeks.
 * Every scenario the Media Buyer rules look for is injected deliberately so
 * the demo and tests can show each one firing:
 *   - a clear winner to scale              (Hearthline / Lookalike 1%)
 *   - creative fatigue on one ad           (Hearthline / "Hands around mug" static)
 *   - a tracking break in the last 3 days  (Bluewater / Interests)
 *   - a CPA spike                          (Kindred Kitchens / Broad)
 *   - ROAS below floor                     (Northlight Hospice / Retargeting)
 *   - an ad with zero donations            (Paws & Place / "Puppy" video)
 *   - a learning-limited ad set            (Bright Start / Interests)
 */

export interface MockDataOptions {
  seed?: string;
  asOf?: string;
  days?: number;
}

interface AdsetProfile {
  name: string;
  dailyBudget: number;
  baseCtr: number; // %
  baseCpm: number;
  /** Desired steady-state ROAS as a multiple of the client target (1.0 = exactly on target). */
  roasFactor: number;
  avgGift: number;
  learning?: AdSetRef["learningStatus"];
  scenario?: "winner" | "tracking-break" | "cpa-spike" | "roas-floor" | "learning-limited";
  ads: Array<{ name: string; type: AdRef["creativeType"]; scenario?: "fatigue" | "zero-conv"; launchedDaysAgo?: number }>;
}

interface ClientProfile {
  id: string;
  name: string;
  targetRoas: number;
  targetCpa: number;
  campaigns: Array<{ name: string; objective: CampaignRef["objective"]; adsets: AdsetProfile[] }>;
}

export const CLIENT_PROFILES: ClientProfile[] = [
  {
    id: "hearthline",
    name: "Hearthline",
    targetRoas: 3,
    targetCpa: 14,
    campaigns: [
      {
        name: "Winter Warmth Appeal 2026",
        objective: "donations",
        adsets: [
          {
            name: "WW - Lookalike 1% Donors",
            dailyBudget: 120,
            baseCtr: 1.6,
            baseCpm: 9,
            roasFactor: 1.6,
            avgGift: 42,
            scenario: "winner",
            ads: [
              { name: "WW - Static Two Kitchens", type: "static" },
              { name: "WW - UGC Priya 30s", type: "ugc" },
            ],
          },
          {
            name: "WW - Interests Older Parents",
            dailyBudget: 80,
            baseCtr: 1.2,
            baseCpm: 8,
            roasFactor: 1.15,
            avgGift: 38,
            ads: [
              { name: "WW - Static Hands Mug", type: "static", scenario: "fatigue", launchedDaysAgo: 45 },
              { name: "WW - Video Home Visit", type: "video" },
              { name: "WW - Static £30 Stat", type: "static", launchedDaysAgo: 10 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "bluewater",
    name: "Bluewater Trust",
    targetRoas: 2.5,
    targetCpa: 15,
    campaigns: [
      {
        name: "Ocean Cleanup Autumn",
        objective: "donations",
        adsets: [
          {
            name: "OC - Interests Marine",
            dailyBudget: 90,
            baseCtr: 1.3,
            baseCpm: 7.5,
            roasFactor: 1.2,
            avgGift: 35,
            scenario: "tracking-break",
            ads: [
              { name: "OC - Video Beach Clean", type: "video" },
              { name: "OC - Carousel Species", type: "carousel" },
            ],
          },
          {
            name: "OC - Retargeting Site Visitors",
            dailyBudget: 40,
            baseCtr: 2.1,
            baseCpm: 11,
            roasFactor: 1.25,
            avgGift: 40,
            ads: [{ name: "OC - Static Reminder", type: "static" }],
          },
        ],
      },
    ],
  },
  {
    id: "kindred",
    name: "Kindred Kitchens",
    targetRoas: 3.5,
    targetCpa: 9,
    campaigns: [
      {
        name: "Food Bank Winter",
        objective: "donations",
        adsets: [
          {
            name: "FB - Broad UK 35+",
            dailyBudget: 150,
            baseCtr: 1.4,
            baseCpm: 6.5,
            roasFactor: 1.05,
            avgGift: 30,
            scenario: "cpa-spike",
            ads: [
              { name: "FB - Static Shelf", type: "static" },
              { name: "FB - UGC Volunteer", type: "ugc" },
              { name: "FB - Video Delivery Van", type: "video" },
            ],
          },
        ],
      },
      {
        name: "Regular Giving Evergreen",
        objective: "regular_giving",
        adsets: [
          {
            name: "RG - Lookalike Regular Givers",
            dailyBudget: 60,
            baseCtr: 1.1,
            baseCpm: 8.5,
            roasFactor: 1.1,
            avgGift: 96, // annualised monthly gift value
            ads: [
              { name: "RG - Static £5 a Month", type: "static" },
              { name: "RG - Video Thank You", type: "video" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "northlight",
    name: "Northlight Hospice",
    targetRoas: 3,
    targetCpa: 15,
    campaigns: [
      {
        name: "Hospice Regular Giving",
        objective: "regular_giving",
        adsets: [
          {
            name: "HRG - Retargeting Engagers",
            dailyBudget: 70,
            baseCtr: 1.5,
            baseCpm: 10,
            roasFactor: 0.3,
            avgGift: 48,
            scenario: "roas-floor",
            ads: [
              { name: "HRG - Video Nurse", type: "video" },
              { name: "HRG - Static Garden", type: "static" },
            ],
          },
          {
            name: "HRG - Interests Local 45+",
            dailyBudget: 55,
            baseCtr: 1.2,
            baseCpm: 8,
            roasFactor: 1.15,
            avgGift: 45,
            ads: [{ name: "HRG - Static Local", type: "static" }],
          },
        ],
      },
    ],
  },
  {
    id: "paws",
    name: "Paws & Place",
    targetRoas: 3,
    targetCpa: 10,
    campaigns: [
      {
        name: "Rescue Appeal",
        objective: "donations",
        adsets: [
          {
            name: "RA - Interests Pets",
            dailyBudget: 100,
            baseCtr: 1.9,
            baseCpm: 7,
            roasFactor: 1.3,
            avgGift: 28,
            ads: [
              { name: "RA - Static Before After", type: "static" },
              { name: "RA - Video Puppy", type: "video", scenario: "zero-conv", launchedDaysAgo: 9 },
              { name: "RA - UGC Adopter", type: "ugc" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "brightstart",
    name: "Bright Start Literacy",
    targetRoas: 2.5,
    targetCpa: 13,
    campaigns: [
      {
        name: "Literacy Autumn",
        objective: "donations",
        adsets: [
          {
            name: "LA - Interests Parents",
            dailyBudget: 35,
            baseCtr: 1.0,
            baseCpm: 9,
            roasFactor: 1.0,
            avgGift: 33,
            learning: "learning_limited",
            scenario: "learning-limited",
            ads: [
              { name: "LA - Static Bookshelf", type: "static" },
              { name: "LA - Video Reading", type: "video" },
            ],
          },
        ],
      },
    ],
  },
];

export function generateMockDataset(options: MockDataOptions = {}): AdsDataset {
  const seed = options.seed ?? "toast-demo";
  const asOf = options.asOf ?? "2026-11-08";
  const days = options.days ?? 56;
  const start = addDays(asOf, -(days - 1));
  const dates = dateRange(start, asOf);
  const rng = new Rng(seed);

  const clients: ClientRef[] = [];
  const campaigns: CampaignRef[] = [];
  const adsets: AdSetRef[] = [];
  const ads: AdRef[] = [];
  const metrics: AdMetricsDaily[] = [];

  for (const cp of CLIENT_PROFILES) {
    clients.push({ id: cp.id, name: cp.name, adAccountId: `act_${hashId(cp.id)}`, targetRoas: cp.targetRoas, targetCpaGbp: cp.targetCpa });
    cp.campaigns.forEach((camp, ci) => {
      const campaignId = `${cp.id}-c${ci + 1}`;
      campaigns.push({ id: campaignId, clientId: cp.id, name: camp.name, objective: camp.objective, status: "ACTIVE" });
      camp.adsets.forEach((as, ai) => {
        const adsetId = `${campaignId}-as${ai + 1}`;
        adsets.push({ id: adsetId, campaignId, clientId: cp.id, name: as.name, dailyBudgetGbp: as.dailyBudget, status: "ACTIVE", learningStatus: as.learning ?? "active" });
        const adList = as.ads.map((ad, adi) => {
          const adId = `${adsetId}-ad${adi + 1}`;
          const launchedOn = addDays(asOf, -(ad.launchedDaysAgo ?? days - 1));
          ads.push({ id: adId, adsetId, campaignId, clientId: cp.id, name: ad.name, creativeType: ad.type, status: "ACTIVE", launchedOn });
          return { ...ad, adId, launchedOn };
        });

        dates.forEach((date, dayIndex) => {
          const daysToEnd = days - 1 - dayIndex; // 0 on asOf
          const live = adList.filter((a) => a.launchedOn <= date);
          if (live.length === 0) return;
          const budgetShare = as.dailyBudget / live.length;
          const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
          const weekend = dow === 0 || dow === 6 ? 0.9 : 1;

          for (const ad of live) {
            let spend = budgetShare * weekend * (0.85 + rng.next() * 0.3);
            let cpm = as.baseCpm * (0.9 + rng.next() * 0.2) * typeMultiplier(ad.type).cpm;
            let ctr = as.baseCtr * (0.85 + rng.next() * 0.3) * typeMultiplier(ad.type).ctr;
            let avgGift = as.avgGift * (0.85 + rng.next() * 0.3);
            // Derive the conversion rate from the desired ROAS so each ad set lands where the scenario needs it:
            // CPC = CPM / (10 * CTR%), desired CPA = avgGift / (target * factor), conv% = CPC / CPA * 100.
            const cpc = cpm / (10 * ctr);
            const desiredCpa = as.avgGift / (cp.targetRoas * as.roasFactor);
            let conv = (cpc / desiredCpa) * 100 * (0.85 + rng.next() * 0.3) * typeMultiplier(ad.type).conv;
            let reachRatio = 0.62; // impressions per unique reach -> frequency ~1.6

            // Scenario injections. "daysToEnd" counts back from the as-of date.
            if (as.scenario === "tracking-break" && daysToEnd <= 2) conv = 0;
            if (as.scenario === "cpa-spike" && daysToEnd <= 6) conv *= 0.55;
            if (as.scenario === "learning-limited") spend *= 0.6;
            if (ad.scenario === "fatigue" && daysToEnd <= 6) {
              ctr *= 0.55;
              reachRatio = 0.23; // frequency ~4.3
            }
            if (ad.scenario === "zero-conv") conv = 0;

            const impressions = Math.max(0, Math.round((spend / cpm) * 1000));
            const linkClicks = Math.round(impressions * (ctr / 100));
            const clicks = Math.round(linkClicks * (1.25 + rng.next() * 0.2));
            const conversions = Math.round(linkClicks * (conv / 100) + rng.normal(0, 0.6));
            const safeConversions = Math.max(0, conv === 0 ? 0 : conversions);
            const revenue = safeConversions * avgGift;
            const reach = Math.round(impressions * reachRatio);

            metrics.push({
              date,
              clientId: cp.id,
              campaignId,
              adsetId,
              adId: ad.adId,
              spend: round2(spend),
              impressions,
              reach,
              clicks,
              linkClicks,
              conversions: safeConversions,
              revenue: round2(revenue),
            });
          }
        });
      });
    });
  }

  return { clients, campaigns, adsets, ads, metrics, range: { start, end: asOf } };
}

function typeMultiplier(type: AdRef["creativeType"]): { cpm: number; ctr: number; conv: number } {
  switch (type) {
    case "video":
      return { cpm: 0.95, ctr: 1.1, conv: 0.95 };
    case "ugc":
      return { cpm: 0.9, ctr: 1.25, conv: 1.1 };
    case "carousel":
      return { cpm: 1.05, ctr: 0.95, conv: 1.0 };
    default:
      return { cpm: 1, ctr: 1, conv: 1 };
  }
}

function hashId(s: string): string {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000_007;
  return String(100000000000 + h);
}


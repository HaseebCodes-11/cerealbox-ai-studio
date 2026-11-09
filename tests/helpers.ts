import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseBrief, type CampaignBrief } from "../src/core/brief";
import { MockProvider } from "../src/core/llm";
import { RawClipSchema, type RawClip } from "../src/areas/video/types";
import { buildMockIdea } from "../src/areas/ideas/generate";
import { buildMockCopy } from "../src/areas/copy/generate";
import type { Idea } from "../src/areas/ideas/types";
import type { CopyPack } from "../src/areas/copy/types";

export const ROOT = join(import.meta.dirname, "..");

export function sampleBrief(): CampaignBrief {
  return parseBrief(JSON.parse(readFileSync(join(ROOT, "samples/brief-winter-warmth.json"), "utf8")));
}

export function sampleClips(): RawClip[] {
  return z.array(RawClipSchema).parse(JSON.parse(readFileSync(join(ROOT, "samples/raw-clips.json"), "utf8")));
}

export function provider(seed = "test"): MockProvider {
  return new MockProvider({ seed });
}

export function sampleIdea(brief = sampleBrief(), angle: Idea["angle"] = "question"): Idea {
  return buildMockIdea(brief, angle, 0);
}

export function sampleCopy(brief = sampleBrief(), idea = sampleIdea(brief)): CopyPack {
  return buildMockCopy(brief, idea);
}

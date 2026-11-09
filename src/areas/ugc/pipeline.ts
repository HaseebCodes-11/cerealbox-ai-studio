import type { CampaignBrief } from "../../core/brief";
import { defineTask } from "../../core/llm/provider";
import type { Script } from "../scripts/types";
import { CreatorPersonaSchema, type CreatorPersona, type RenderJob, type Shot, type UgcManifest, type UgcRenderer } from "./types";

export interface PersonaInput {
  brief: CampaignBrief;
  script: Script;
  /** Whether a synthetic presenter is acceptable for this client. */
  allowSynthetic: boolean;
}

const SYSTEM = `You cast presenters for charity UGC-style ads.
Choose a persona the target audience will trust: usually someone like them (a daughter, a neighbour, a volunteer), not a celebrity and not the person being helped.
If a synthetic presenter is allowed, say so only when the script is informational rather than testimonial; synthetic "testimonials" are misleading and not permitted.
Describe the persona concretely (age range, look, energy, voice) and explain why it fits the audience.`;

export const personaTask = defineTask<PersonaInput, CreatorPersona>({
  name: "ugc.persona",
  description: "Choose a presenter persona for a UGC-style script",
  schema: CreatorPersonaSchema,
  system: SYSTEM,
  effort: "low",
  prompt: ({ brief, script, allowSynthetic }) =>
    [
      `Client: ${brief.client.name}. Audience: ${brief.audience.description}.`,
      `Script style: ${script.style}. First beat: ${script.beats[0]?.voiceover ?? ""}`,
      `Synthetic presenter allowed: ${allowSynthetic ? "yes" : "no"}.`,
      `Brand tone: ${brief.client.voice.tone.join(", ")}.`,
    ].join("\n"),
  mock: ({ brief, script, allowSynthetic }, { rng }) => {
    const testimonial = script.style === "ugc-testimonial";
    const synthetic = allowSynthetic && !testimonial;
    const range = brief.audience.ageRange ?? "35-55";
    const [lo, hi] = range.split("-").map((n) => Number(n));
    const age = Number.isFinite(lo) && Number.isFinite(hi) ? rng.int(lo!, hi!) : 45;
    const names = ["Priya", "Sam", "Jo", "Amina", "Chris", "Dee", "Tom", "Leah"];
    const name = rng.pick(names);
    const setting = brief.creativeContext.settingNoun;
    return {
      name: testimonial ? `${name}, ${age}, supporter who has seen it first-hand` : `${name}, ${age}, long-time volunteer`,
      ageRange: range,
      description: testimonial
        ? `Warm, slightly rushed energy of someone filming between errands; natural ${setting} setting, no make-up artist, phone propped on a shelf.`
        : "Calm, plain-spoken volunteer in a branded fleece, filmed where the work happens; explains rather than performs.",
      voiceStyle: testimonial ? "conversational, regional UK accent, small pauses, no script-reading cadence" : "steady, clear, reassuring",
      synthetic,
      whyThisPersona: `The audience (${brief.audience.name}) trusts peers over institutions; ${testimonial ? `someone who can honestly say "${brief.creativeContext.storySeed}" mirrors their situation` : "a volunteer can explain the operation credibly"}.${synthetic ? " Synthetic presenter acceptable because the script is informational, not a testimonial." : ""}`,
    };
  },
});

export interface UgcOptions {
  persona: CreatorPersona;
  /** Default provider choices; a synthetic persona switches avatar/voice to AI providers. */
  preferRealCreator?: boolean;
  reviewerName?: string;
}

/** Cost and turnaround assumptions used for planning; refreshed quarterly from supplier quotes. */
export const UGC_COST_TABLE = {
  "real-creator": { costGbp: 350, hours: 120 },
  heygen: { costGbp: 25, hours: 2 },
  synthesia: { costGbp: 40, hours: 3 },
  none: { costGbp: 0, hours: 0 },
} as const;

/** Deterministic transformation: approved script + persona -> production manifest. */
export function buildUgcManifest(script: Script, brief: CampaignBrief, options: UgcOptions): UgcManifest {
  const { persona } = options;
  const synthetic = persona.synthetic;
  const avatarProvider = synthetic ? "heygen" : "real-creator";
  const voiceProvider = synthetic ? "elevenlabs" : "real-creator";
  const cost = UGC_COST_TABLE[avatarProvider];

  const shots: Shot[] = script.beats.map((beat) => ({
    beatName: beat.name,
    camera: beat.name === "hook" ? "Handheld selfie, eye level, slight movement" : beat.name === "cta" ? "Static, presenter centred, end card overlay" : "Handheld selfie or cutaway to b-roll",
    setting: synthetic ? "Neutral home interior background (avatar scene)" : "Presenter's own kitchen or living room, daylight",
    action: beat.visual,
    dialogue: beat.voiceover,
    onScreenText: beat.onScreenText,
    props: beat.brollKeywords.slice(0, 3),
    durationSec: beat.seconds,
  }));

  const aiGenerated = synthetic || voiceProvider !== "real-creator";
  return {
    id: `ugc-${script.id}`,
    scriptId: script.id,
    persona,
    shots,
    voice: {
      provider: voiceProvider,
      settings: synthetic ? { stability: 0.45, similarityBoost: 0.75, style: 0.35, accent: "british" } : { direction: persona.voiceStyle },
    },
    avatar: {
      provider: avatarProvider,
      settings: synthetic ? { avatarStyle: "casual-home", lookAt: "camera", background: "home-kitchen" } : { briefDeliveryFormat: "PDF shot list + script", usageRights: "paid social, 12 months, UK" },
    },
    captions: script.captionStyle,
    aspect: script.aspect,
    deliverables: [
      { format: "mp4 1080x1920 h264", filename: `${script.id}-9x16.mp4`, placement: "meta_reels, meta_stories" },
      { format: "mp4 1080x1080 h264", filename: `${script.id}-1x1.mp4`, placement: "meta_feed" },
      { format: "srt", filename: `${script.id}.srt`, placement: "captions" },
    ],
    disclosure: {
      aiGenerated,
      label: aiGenerated ? "Presenter and/or voice created with AI. Story based on real cases supported by " + brief.client.name + "." : "Real creator. No synthetic media.",
      metaAiDisclosureFlag: aiGenerated,
    },
    approvals: [
      { gate: "script", owner: options.reviewerName ?? "creative-lead", status: "approved" },
      { gate: "persona", owner: options.reviewerName ?? "client-services", status: "pending" },
      { gate: "rough-cut", owner: options.reviewerName ?? "creative-lead", status: "pending" },
      { gate: "final", owner: options.reviewerName ?? "client", status: "pending" },
    ],
    estimatedCostGbp: cost.costGbp,
    estimatedTurnaroundHours: cost.hours,
  };
}

/** A manifest is only submittable when every gate before "final" has been approved. */
export function canSubmitForRender(manifest: UgcManifest): { ok: boolean; blockedBy: string[] } {
  const blockedBy = manifest.approvals.filter((a) => a.gate !== "final" && a.status !== "approved").map((a) => a.gate);
  return { ok: blockedBy.length === 0, blockedBy };
}

export function approveGate(manifest: UgcManifest, gate: UgcManifest["approvals"][number]["gate"], owner: string, note?: string): UgcManifest {
  return {
    ...manifest,
    approvals: manifest.approvals.map((a) => (a.gate === gate ? { ...a, status: "approved", owner, ...(note ? { note } : {}) } : a)),
  };
}

/** Simulated avatar/voice renderer for demos and tests. */
export class MockUgcRenderer implements UgcRenderer {
  readonly name = "mock-renderer";
  private readonly jobs = new Map<string, { polls: number; manifest: UgcManifest }>();

  async submit(manifest: UgcManifest): Promise<RenderJob> {
    const gate = canSubmitForRender(manifest);
    if (!gate.ok) {
      return { jobId: "", status: "failed", error: `Blocked by unapproved gates: ${gate.blockedBy.join(", ")}` };
    }
    const jobId = `job-${manifest.id}`;
    this.jobs.set(jobId, { polls: 0, manifest });
    return { jobId, status: "queued" };
  }

  async poll(jobId: string): Promise<RenderJob> {
    const job = this.jobs.get(jobId);
    if (!job) return { jobId, status: "failed", error: "Unknown job" };
    job.polls++;
    if (job.polls === 1) return { jobId, status: "rendering" };
    return { jobId, status: "done", outputUrl: `mock://renders/${job.manifest.deliverables[0]?.filename ?? "output.mp4"}` };
  }
}

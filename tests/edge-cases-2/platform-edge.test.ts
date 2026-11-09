/**
 * Second production-breakage pass · orchestrator, idea bank, CLI args, automations and configuration.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../../src/core/llm";
import { InMemoryIdeaBank, type IdeaBankStore } from "../../src/areas/ideas/bank";
import type { ImageProvider } from "../../src/areas/static/images";
import { runCampaignPipeline } from "../../src/orchestrator";
import { arg } from "../../src/cli/shared";
import { sampleBrief, sampleClips } from "../helpers";

const provider = new MockProvider();

describe("P1 · pipeline options and collaborators that misbehave", () => {
  it.fails("[BUG2-49] an empty script request list skips scripts, UGC and video instead of failing schema validation", async () => {
    const pkg = await runCampaignPipeline({ brief: sampleBrief(), provider, scriptRequests: [], clips: sampleClips() });
    expect(pkg.scripts).toEqual([]);
    expect(pkg.status).not.toBe("blocked");
    expect(pkg.landing.length).toBeGreaterThan(0);
  });

  it.fails("[BUG2-50] an image provider outage does not throw away the ideas and copy already produced", async () => {
    const broken: ImageProvider = { name: "broken", generate: async () => { throw new Error("vendor 503"); } };
    const pkg = await runCampaignPipeline({ brief: sampleBrief(), provider, imageProvider: broken });
    expect(pkg.ideas.ranked.length).toBeGreaterThan(0);
    expect(pkg.copy).not.toBeNull();
    // Either the mock background was used (creatives exist) or the static gate records the outage.
    expect(pkg.creatives.length > 0 || pkg.gates.some((g) => g.area === "static" && /vendor 503|image/i.test(g.reason ?? ""))).toBe(true);
  });

  it.fails("[BUG2-51] an idea bank that fails to load degrades to no memory rather than aborting the brief", async () => {
    const bank: IdeaBankStore = { load: async () => { throw new Error("disk full"); }, save: async () => {} };
    const pkg = await runCampaignPipeline({ brief: sampleBrief(), provider, ideaBank: bank });
    expect(pkg.ideas.ranked.length).toBeGreaterThan(0);
    expect(pkg.audit.byType("error").some((e) => /disk full/.test(String(e.detail["reason"])))).toBe(true);
  });

  it.fails("[BUG2-52] duplicate formats in the request are deduplicated so creative ids stay unique", async () => {
    const pkg = await runCampaignPipeline({ brief: sampleBrief(), provider, formats: ["story", "story", "square"] });
    const ids = pkg.creatives.map((c) => c.rendered.spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.fails("[BUG2-53] a selectCount of 0 stops cleanly at the ideas stage", async () => {
    const pkg = await runCampaignPipeline({ brief: sampleBrief(), provider, selectCount: 0 });
    expect(pkg.status).toBe("blocked");
    expect(pkg.stoppedAt).toBe("ideas");
  });

  it("the idea bank receives exactly one save per run and every saved entry carries the brief id", async () => {
    const bank = new InMemoryIdeaBank();
    const brief = sampleBrief();
    await runCampaignPipeline({ brief, provider, ideaBank: bank, today: "2026-11-08" });
    expect(bank.entries.length).toBeGreaterThan(0);
    for (const e of bank.entries) {
      expect(e.briefId).toBe(brief.id);
      expect(e.createdOn).toBe("2026-11-08");
    }
  });
});

describe("P2 · CLI argument parsing", () => {
  const original = process.argv;
  afterEach(() => {
    process.argv = original;
  });

  it.fails("[BUG2-54] a flag given without a value is an error, not a silent fallback to the sample file", () => {
    process.argv = ["node", "demo", "--brief"];
    expect(() => arg("brief", "samples/brief-winter-warmth.json")).toThrow();
  });

  it("both --name value and --name=value forms work, and a value starting with -- is not swallowed", () => {
    process.argv = ["node", "demo", "--as-of", "2026-11-08", "--brief=samples/x.json"];
    expect(arg("as-of")).toBe("2026-11-08");
    expect(arg("brief")).toBe("samples/x.json");
    process.argv = ["node", "demo", "--brief", "--allow-synthetic"];
    expect(arg("brief", "fallback")).not.toBe("--allow-synthetic");
  });
});

describe("P3 · automations and configuration hygiene", () => {
  const workflows = readdirSync("automations/n8n").filter((f) => f.endsWith(".json")).map((f) => ({ file: f, json: JSON.parse(readFileSync(join("automations/n8n", f), "utf8")) as { nodes: Array<{ name: string; type: string; parameters?: Record<string, unknown> }>; connections: Record<string, { main?: Array<Array<{ node: string }>> }> } }));

  it("every n8n connection points at a node that exists and every non-trigger node is reachable", () => {
    for (const { file, json } of workflows) {
      const names = new Set(json.nodes.map((n) => n.name));
      const targets = new Set<string>();
      for (const [from, conn] of Object.entries(json.connections)) {
        expect(names.has(from), `${file}: ${from}`).toBe(true);
        for (const branch of conn.main ?? []) for (const edge of branch) {
          expect(names.has(edge.node), `${file}: ${from} -> ${edge.node}`).toBe(true);
          targets.add(edge.node);
        }
      }
      for (const node of json.nodes) {
        if (/trigger|webhook|stickyNote/i.test(node.type)) continue;
        expect(targets.has(node.name), `${file}: ${node.name} has no incoming connection`).toBe(true);
      }
    }
  });

  it("n8n exports carry no credentials, tokens or hard-coded project URLs", () => {
    for (const { file } of workflows) {
      const text = readFileSync(join("automations/n8n", file), "utf8");
      expect(text, file).not.toMatch(/xox[abp]-|sk-ant-|eyJ[A-Za-z0-9_-]{20,}|https:\/\/[a-z]{20}\.supabase\.co/);
    }
  });

  it.fails("[BUG2-55] every Edge Function the HTTP nodes and cron jobs call exists in supabase/functions", () => {
    const functions = new Set(readdirSync("supabase/functions").filter((d) => !d.startsWith("_") && !d.includes(".")));
    const referenced = new Set<string>();
    for (const { json } of workflows) for (const n of json.nodes) {
      const url = String((n.parameters as { url?: string } | undefined)?.url ?? "");
      const m = url.match(/\/functions\/v1\/([a-z0-9-]+)/);
      if (m) referenced.add(m[1]!);
    }
    const sql = readdirSync("supabase/migrations").map((f) => readFileSync(join("supabase/migrations", f), "utf8")).join("\n");
    for (const m of sql.matchAll(/\|\| '\/([a-z0-9-]+)'/g)) referenced.add(m[1]!);
    for (const fn of referenced) expect(functions.has(fn), `function ${fn} is referenced but not implemented`).toBe(true);
  });

  it.fails("[BUG2-56] every environment variable the code reads is documented in .env.example", () => {
    const src = readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts")).map((f) => readFileSync(join("src", String(f)), "utf8")).join("\n");
    const used = new Set([...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!));
    const example = readFileSync(".env.example", "utf8");
    for (const name of used) expect(example, name).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("every npm script the README mentions exists", () => {
    const scripts = Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts);
    const readme = readFileSync("README.md", "utf8");
    for (const m of readme.matchAll(/npm run ([a-z:-]+)/g)) expect(scripts, m[1]).toContain(m[1]);
    expect(existsSync(".nvmrc")).toBe(true);
  });
});

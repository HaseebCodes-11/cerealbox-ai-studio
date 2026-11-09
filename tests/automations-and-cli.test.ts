import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT } from "./helpers";

const AREAS = ["Copywriting", "Static Creative", "Script Writing", "UGC Video", "Video Editing", "Media Buyer", "Idea Generator", "Landing Pages", "Toast"];

describe("n8n workflow exports", () => {
  const files = readdirSync(join(ROOT, "automations/n8n")).filter((f) => f.endsWith(".json"));

  it("ships two importable workflows", () => {
    expect(files.sort()).toEqual(["ads-agent-approval.json", "toast-daily-digest.json"]);
  });

  for (const file of files) {
    it(`${file} is structurally valid: unique node names, connections point at real nodes`, () => {
      const wf = JSON.parse(readFileSync(join(ROOT, "automations/n8n", file), "utf8"));
      expect(typeof wf.name).toBe("string");
      expect(Array.isArray(wf.nodes)).toBe(true);
      const names = wf.nodes.map((n: { name: string }) => n.name);
      expect(new Set(names).size).toBe(names.length);
      for (const node of wf.nodes) {
        expect(node.type, node.name).toMatch(/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./);
        expect(typeof node.typeVersion).toBe("number");
        expect(node.position).toHaveLength(2);
      }
      for (const [from, outputs] of Object.entries(wf.connections as Record<string, { main: Array<Array<{ node: string }>> }>)) {
        expect(names, `source ${from}`).toContain(from);
        for (const branch of outputs.main) for (const target of branch) expect(names, `target ${target.node}`).toContain(target.node);
      }
      const trigger = wf.nodes.find((n: { type: string }) => /trigger|webhook/i.test(n.type));
      expect(trigger, "has a trigger node").toBeTruthy();
      expect(wf.settings.timezone).toBe("Europe/London");
    });
  }

  it("the approval loop routes human and approve tiers differently", () => {
    const wf = JSON.parse(readFileSync(join(ROOT, "automations/n8n/ads-agent-approval.json"), "utf8"));
    const route = wf.connections["Route by risk tier"].main;
    expect(route[0][0].node).toBe("Escalate to Slack");
    expect(route[1][0].node).toBe("Ask for approval (Slack)");
    const approve = wf.nodes.find((n: { name: string }) => n.name === "Ask for approval (Slack)");
    expect(approve.parameters.operation).toBe("sendAndWait");
  });
});

describe("supabase schema", () => {
  const sql = readFileSync(join(ROOT, "supabase/migrations/0001_ai_studio_schema.sql"), "utf8");

  it("creates every table the workflows need with RLS and scheduled jobs", () => {
    for (const table of ["campaign_briefs", "artefacts", "review_gates", "model_calls", "agent_runs", "agent_recommendations", "agent_actions", "toast_digests", "toast_questions", "idea_bank"]) {
      expect(sql, table).toMatch(new RegExp(`create table if not exists ${table}`));
      expect(sql, `${table} RLS`).toMatch(new RegExp(`alter table\\s+${table}\\s+enable row level security`));
    }
    expect((sql.match(/cron\.schedule\(/g) ?? []).length).toBe(4);
    expect(sql).toContain("create policy");
    expect(sql).toMatch(/check \(risk in \('auto','approve','human'\)\)/);
    expect(sql).toMatch(/check \(autonomy in \('assist','copilot','autopilot'\)\)/);
  });
});

describe("supabase edge functions", () => {
  const dir = join(ROOT, "supabase/functions");

  it("ships four Deno handlers that reuse the pipeline modules behind service-role auth", () => {
    const expected = ["toast-insights", "ads-agent-run", "ads-agent-execute", "run-pipeline-stage"];
    for (const name of expected) {
      const src = readFileSync(join(dir, name, "index.ts"), "utf8");
      expect(src, name).toContain("Deno.serve(");
      expect(src, name).toContain("requireServiceRole(req)");
      expect(src, name).toContain("@supabase/supabase-js");
    }
    expect(readFileSync(join(dir, "toast-insights/index.ts"), "utf8")).toContain("generateInsights");
    expect(readFileSync(join(dir, "ads-agent-run/index.ts"), "utf8")).toContain("runMediaBuyerAgent");
    expect(readFileSync(join(dir, "run-pipeline-stage/index.ts"), "utf8")).toContain("ideaGenerationTask");
    const deno = JSON.parse(readFileSync(join(dir, "deno.json"), "utf8"));
    expect(deno.unstable).toContain("sloppy-imports");
    expect(deno.imports.zod).toMatch(/^npm:zod/);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("every src module the functions import exists", () => {
    for (const name of ["toast-insights", "ads-agent-run", "ads-agent-execute", "run-pipeline-stage"]) {
      const src = readFileSync(join(dir, name, "index.ts"), "utf8");
      const imports = [...src.matchAll(/from "(\.\.\/\.\.\/\.\.\/src\/[^"]+)"/g)].map((m) => m[1]!);
      for (const rel of imports) {
        const target = join(dir, name, rel);
        expect(existsSync(`${target}.ts`) || existsSync(join(target, "index.ts")), `${name}: ${rel}`).toBe(true);
      }
    }
  });
});

describe("documentation", () => {
  it("covers every area in the brief and the required interview sections", () => {
    const submission = readFileSync(join(ROOT, "docs/SUBMISSION.md"), "utf8");
    for (const area of AREAS) expect(submission, area).toContain(area);
    for (const section of ["Quality controls", "Maintenance", "Scale and cost", "Next steps", "human review"]) expect(submission.toLowerCase(), section).toContain(section.toLowerCase());
    const roadmap = readFileSync(join(ROOT, "docs/ROADMAP.md"), "utf8");
    for (const milestone of ["2 weeks", "30 days", "60 days", "90 days"]) expect(roadmap, milestone).toContain(milestone);
    expect(readdirSync(join(ROOT, "docs/areas")).filter((f) => f.endsWith(".md"))).toHaveLength(9);
    for (const f of ["README.md", "docs/DEMO_SCRIPT.md", "docs/ARCHITECTURE.md", "docs/deck.html", ".github/workflows/verify.yml"]) expect(existsSync(join(ROOT, f)), f).toBe(true);
    const deck = readFileSync(join(ROOT, "docs/deck.html"), "utf8");
    for (const area of AREAS) expect(deck, `deck mentions ${area}`).toContain(area);
    expect((deck.match(/<section class="slide/g) ?? []).length).toBeGreaterThanOrEqual(10);
    const ci = readFileSync(join(ROOT, ".github/workflows/verify.yml"), "utf8");
    expect(ci).toContain("npm run verify");
    expect(ci).toContain("ANTHROPIC_API_KEY");
  });

  it("package scripts referenced in the docs exist", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const script of ["demo", "demo:all", "toast", "toast:ask", "agent", "eval", "video", "reports", "web", "web:build", "typecheck", "typecheck:web", "test", "verify"]) expect(pkg.scripts[script], script).toBeTruthy();
  });
});

describe("CLI end to end", () => {
  const out = mkdtempSync(join(tmpdir(), "cbx-out-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const run = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/cli", script), ...args], {
      cwd: ROOT,
      env: { ...process.env, OUT_DIR: out, LLM_PROVIDER: "mock" },
      encoding: "utf8",
      timeout: 120_000,
    });

  it("demo writes every artefact", () => {
    const stdout = run("demo.ts");
    expect(stdout).toContain("Creatives: 3/3 pass QA");
    expect(stdout).toContain("Landing pages: 2/2 pass QA");
    const brief = join(out, "brief-2026-winter-warmth");
    for (const f of ["SUMMARY.md", "01-ideas.md", "02-copy.md", "03-creatives.md", "04-scripts.md", "05-ugc-manifest.json", "06-video/captions.srt", "06-video/render-plan.sh", "07-landing/variant-A.html", "07-landing/variant-B.html", "08-launch-plan.json", "09-review-gates.md", "10-audit.json"]) {
      expect(existsSync(join(brief, f)), f).toBe(true);
    }
    expect(readdirSync(join(brief, "03-creatives")).filter((f) => f.endsWith(".png"))).toHaveLength(3);
    for (const f of ["toast/dashboard.html", "toast/insights.md", "toast/ask-toast.md", "agent/recommendations.md", "agent/alerts.md", "agent/briefs.md"]) expect(existsSync(join(out, f)), f).toBe(true);
    const summary = readFileSync(join(brief, "SUMMARY.md"), "utf8");
    expect(summary).toContain("Pipeline status: **complete**");
    for (const f of ["11-quality-judgement.md", "review-queue.json", "08-meta-payloads.json"]) expect(existsSync(join(brief, f)), f).toBe(true);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(existsSync(join(out, "idea-bank.json"))).toBe(true);
    const payloads = JSON.parse(readFileSync(join(brief, "08-meta-payloads.json"), "utf8"));
    expect(payloads.summary.allPaused).toBe(true);
    const queue = JSON.parse(readFileSync(join(brief, "review-queue.json"), "utf8"));
    expect(queue.items).toHaveLength(7);
    expect(Object.keys(queue.cost.byArea).length).toBeGreaterThan(3);
  }, 120_000);

  it("a second demo run remembers the first through the idea bank", () => {
    const stdout = run("demo.ts");
    expect(stdout).toMatch(/Idea bank: \d+ previous ideas for Hearthline/);
    const bank = JSON.parse(readFileSync(join(out, "idea-bank.json"), "utf8"));
    expect(bank.length).toBeGreaterThanOrEqual(20);
  }, 120_000);

  it("reports CLI writes verified client reports and drafted replies", () => {
    const stdout = run("reports.ts");
    expect(stdout).not.toContain("UNVERIFIED");
    expect(stdout).toContain("Client comms drafts");
    const index = JSON.parse(readFileSync(join(out, "reports/index.json"), "utf8"));
    expect(index.reports).toHaveLength(6);
    expect(index.reports.every((r: { verified: boolean }) => r.verified)).toBe(true);
    for (const r of index.reports) expect(existsSync(join(out, r.html)), r.html).toBe(true);
    const drafts = JSON.parse(readFileSync(join(out, "comms/replies.json"), "utf8"));
    expect(drafts).toHaveLength(7);
    expect(drafts.filter((d: { risk: string }) => d.risk === "human")).toHaveLength(3);
  }, 120_000);

  it("toast ask answers from the command line", () => {
    const stdout = run("toast.ts", "ask", "Which client had the biggest ROAS drop last week?");
    expect(stdout).toContain("biggest ROAS deterioration");
    expect(stdout).toContain("intent: biggest_change");
  }, 60_000);

  it("eval passes", () => {
    const stdout = run("eval.ts");
    expect(stdout).toContain("EVAL PASSED");
    expect(stdout).toContain("recall 100%");
  }, 120_000);

  it("agent CLI runs in autopilot live mode against the mock client", () => {
    const stdout = run("agent.ts", "--autonomy", "autopilot", "--live");
    expect(stdout).toContain("autonomy=autopilot");
    expect(stdout).toMatch(/Ads client calls: [1-9]/);
  }, 60_000);
});

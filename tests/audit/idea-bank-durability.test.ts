import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileIdeaBank, type IdeaBankEntry } from "../../src/areas/ideas/bank";

const entry = (id: string, clientId = "hearthline"): IdeaBankEntry => ({ clientId, briefId: "b1", ideaId: id, angle: "question", title: `Idea ${id}`, hook: "hook", concept: "concept", total: 7, selected: true, createdOn: "2026-11-08" });

describe("FileIdeaBank durability (SEC-08)", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "idea-bank-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("round-trips entries and filters by client", async () => {
    const path = join(tmp(), "bank.json");
    const bank = new FileIdeaBank(path, () => {});
    await bank.save([entry("a"), entry("b", "paws")]);
    await bank.save([entry("c")]);
    expect((await bank.load("hearthline")).map((e) => e.ideaId)).toEqual(["a", "c"]);
    expect((await bank.load("paws")).map((e) => e.ideaId)).toEqual(["b"]);
  });

  it("leaves no temp file behind and the file is always complete JSON", async () => {
    const dir = tmp();
    const path = join(dir, "bank.json");
    const bank = new FileIdeaBank(path, () => {});
    await Promise.all([bank.save([entry("a")]), bank.save([entry("b")]), bank.save([entry("c")])]);
    expect(readdirSync(dir)).toEqual(["bank.json"]);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("keeps a copy of an unparsable file instead of silently discarding the client's memory", async () => {
    const dir = tmp();
    const path = join(dir, "bank.json");
    writeFileSync(path, '[{"clientId":"hearthline","ideaId":"half-written');
    const warnings: string[] = [];
    const bank = new FileIdeaBank(path, (m) => warnings.push(m));
    expect(await bank.load("hearthline")).toEqual([]);
    expect(bank.lastBackup).toMatch(/bank\.json\.corrupt-/);
    expect(existsSync(bank.lastBackup!)).toBe(true);
    expect(readFileSync(bank.lastBackup!, "utf8")).toContain("half-written");
    expect(warnings[0]).toMatch(/could not be parsed/);
    await bank.save([entry("new")]);
    expect((await bank.load("hearthline")).map((e) => e.ideaId)).toEqual(["new"]);
  });

  it("treats a JSON file that is not an array as corrupt", async () => {
    const path = join(tmp(), "bank.json");
    writeFileSync(path, '{"oops":true}');
    const bank = new FileIdeaBank(path, () => {});
    expect(await bank.load("x")).toEqual([]);
    expect(bank.lastBackup).not.toBeNull();
  });
});

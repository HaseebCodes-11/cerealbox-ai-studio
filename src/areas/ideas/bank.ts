import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RankedIdea } from "./types";

/**
 * The idea bank is the memory that makes novelty real: every idea generated
 * for a client is stored, and the next brief for that client passes them in
 * as "previous ideas" so repeats score lower. In production this is the
 * `idea_bank` table with ad performance joined on; here it is a JSON file so
 * running the demo twice shows the loop working.
 */
export interface IdeaBankEntry {
  clientId: string;
  briefId: string;
  ideaId: string;
  angle: string;
  title: string;
  hook: string;
  concept: string;
  total: number;
  selected: boolean;
  createdOn: string;
  performance?: { roas: number; spend: number } | null;
}

export interface IdeaBankStore {
  load(clientId: string): Promise<IdeaBankEntry[]>;
  save(entries: IdeaBankEntry[]): Promise<void>;
}

export class InMemoryIdeaBank implements IdeaBankStore {
  readonly entries: IdeaBankEntry[] = [];
  async load(clientId: string): Promise<IdeaBankEntry[]> {
    return this.entries.filter((e) => e.clientId === clientId);
  }
  async save(entries: IdeaBankEntry[]): Promise<void> {
    this.entries.push(...entries);
  }
}

export class FileIdeaBank implements IdeaBankStore {
  constructor(private readonly path: string) {}
  private read(): IdeaBankEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as IdeaBankEntry[];
    } catch {
      return [];
    }
  }
  async load(clientId: string): Promise<IdeaBankEntry[]> {
    return this.read().filter((e) => e.clientId === clientId);
  }
  async save(entries: IdeaBankEntry[]): Promise<void> {
    const all = [...this.read(), ...entries];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all, null, 2));
  }
}

/** Text the novelty scorer compares new ideas against. */
export function previousIdeaTexts(entries: IdeaBankEntry[]): string[] {
  return entries.map((e) => `${e.title} ${e.hook} ${e.concept}`);
}

export function toBankEntries(ranked: RankedIdea[], selected: RankedIdea[], clientId: string, briefId: string, createdOn: string): IdeaBankEntry[] {
  const selectedIds = new Set(selected.map((s) => s.id));
  return ranked.map((i) => ({
    clientId,
    briefId,
    ideaId: i.id,
    angle: i.angle,
    title: i.title,
    hook: i.hook,
    concept: i.concept,
    total: i.total,
    selected: selectedIds.has(i.id),
    createdOn,
    performance: null,
  }));
}

/** Angles used in the last N selected ideas for a client, to rotate away from. */
export function recentlyUsedAngles(entries: IdeaBankEntry[], limit = 3): string[] {
  return [...entries]
    .filter((e) => e.selected)
    .sort((a, b) => (a.createdOn < b.createdOn ? 1 : -1))
    .slice(0, limit)
    .map((e) => e.angle);
}

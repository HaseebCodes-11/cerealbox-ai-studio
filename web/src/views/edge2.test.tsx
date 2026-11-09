/**
 * Second production-breakage pass · web views: state that leaks between items, counts that lie,
 * empty states, and the app shell when the data files are missing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AgentView } from "./AgentView";
import { ReviewQueueView } from "./ReviewQueueView";
import type { AgentRun, ReviewQueue } from "../lib/data";

const queue: ReviewQueue = {
  briefId: "brief-1",
  client: "Hearthline",
  campaign: "Winter Warmth",
  status: "complete",
  items: [
    { id: "g1", gate: "ideas.select", area: "ideas", risk: "human", guardrailScore: 100, decision: "approved", summary: "ideas", preview: { kind: "ideas", data: [] } },
    { id: "g2", gate: "copy.approve", area: "copy", risk: "human", guardrailScore: 96, decision: "approved", summary: "copy", preview: { kind: "copy", data: { hooks: ["Keep one neighbour warm 🧣"], headlines: [], descriptions: [], storyOverlays: [], primaryTexts: [] } } },
  ],
};

describe("Q1 · review queue state", () => {
  beforeEach(() => localStorage.clear());

  it.fails("[BUG2-57] a note typed for one gate is not attached to a decision on another gate", () => {
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Swap idea 2 for idea 4" } });
    fireEvent.click(screen.getByText("copy.approve"));
    fireEvent.click(screen.getByText("Approve"));
    const stored = JSON.parse(localStorage.getItem("ai-studio.decisions") ?? "{}") as Record<string, { note?: string }>;
    expect(stored["g2"]?.note ?? "").not.toBe("Swap idea 2 for idea 4");
  });

  it.fails("[BUG2-58] character counts in the copy preview count what a person sees, so an emoji is one character", () => {
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    fireEvent.click(screen.getByText("copy.approve"));
    expect(screen.getByText(`(${[..."Keep one neighbour warm 🧣"].length})`)).toBeInTheDocument();
  });
});

describe("Q2 · agent view empty and partial states", () => {
  const run: AgentRun = { asOf: "2026-11-08", autonomy: "copilot", dryRun: true, recommendations: [], alerts: [], briefs: [], actions: [] };

  it.fails("[BUG2-59] zero briefs shows an explanation instead of a blank card", () => {
    render(<AgentView run={run} />);
    expect(screen.getByText(/no (morning )?briefs|no clients/i)).toBeInTheDocument();
  });

  it("an unknown autonomy value from a stale file does not highlight any ladder step or crash", () => {
    render(<AgentView run={{ ...run, autonomy: "turbo" }} />);
    expect(screen.getByText(/running as turbo/)).toBeInTheDocument();
  });
});

describe("Q3 · app shell without data files", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("tells the user to run the demo when manifest.json is missing", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Could not load \/manifest\.json/)).toBeInTheDocument());
  });
});

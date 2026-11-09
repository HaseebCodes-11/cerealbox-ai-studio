import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ReviewQueueView } from "./ReviewQueueView";
import type { ReviewQueue } from "../lib/data";

const queue: ReviewQueue = {
  briefId: "brief-1",
  client: "Hearthline",
  campaign: "Winter Warmth",
  status: "complete",
  quality: { meanOverall: 7.8, verdictCounts: { ship: 3, revise: 1, reject: 0 } },
  cost: { llmCalls: 8, costUsd: 0.15 },
  items: [
    { id: "g1", gate: "ideas.select", area: "ideas", risk: "human", guardrailScore: 100, decision: "approved", reviewer: "policy", summary: "3 ideas shortlisted", preview: { kind: "ideas", data: [{ rank: 1, title: "Two kitchens, one winter", angle: "contrast", hook: "Same street.", total: 8.2, whyItWorks: "Contrast works." }] } },
    { id: "g2", gate: "copy.approve", area: "copy", risk: "human", guardrailScore: 96, decision: "approved", summary: "3 primary texts", preview: { kind: "copy", data: { hooks: ["Hook one"], headlines: ["Headline one"], descriptions: ["Desc"], storyOverlays: ["Overlay"], primaryTexts: [{ variant: "short", text: "Short text. Donate." }] } } },
    { id: "g3", gate: "static.approve", area: "static", risk: "human", guardrailScore: 100, decision: "approved", summary: "3/3 creatives pass", preview: { kind: "creatives", data: [{ id: "c1", format: "square", layout: "bold-statement", png: "03-creatives/c1.png", score: 100, ok: true, issues: [] }] } },
    { id: "g4", gate: "landing.approve", area: "landing", risk: "human", guardrailScore: 100, decision: "approved", summary: "2/2 pass", preview: { kind: "landing", data: [{ variant: "A", html: "07-landing/variant-A.html", headline: "£30 keeps an older person warm", hypothesis: "Control", ok: true, score: 100 }] } },
  ],
};

describe("ReviewQueueView", () => {
  beforeEach(() => localStorage.clear());

  it("lists every gate as pending and previews the first one", () => {
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    expect(screen.getByText("Gates · 4 awaiting you")).toBeInTheDocument();
    expect(screen.getAllByText("pending")).toHaveLength(4);
    expect(screen.getByText("Two kitchens, one winter", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Mean 7.8\/10/)).toBeInTheDocument();
    expect(screen.getByText(/8 model calls/)).toBeInTheDocument();
  });

  it("approves with a note, persists to localStorage and can undo", () => {
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "Love the contrast" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Gates · 3 awaiting you")).toBeInTheDocument();
    expect(screen.getAllByText("approved").length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(localStorage.getItem("ai-studio.decisions")!);
    expect(stored.g1.status).toBe("approved");
    expect(stored.g1.note).toBe("Love the contrast");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Gates · 4 awaiting you")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ai-studio.decisions")!).g1).toBeUndefined();
  });

  it("switches preview when another gate is selected and rejects", () => {
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    fireEvent.click(screen.getByText("copy.approve"));
    expect(screen.getByText("Headline one", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Short text. Donate.", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getAllByText("rejected").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByText("static.approve"));
    expect(screen.getByAltText("square bold-statement")).toHaveAttribute("src", "/brief-1/03-creatives/c1.png");
    fireEvent.click(screen.getByText("landing.approve"));
    expect(screen.getByTitle("Landing variant A")).toHaveAttribute("src", "/brief-1/07-landing/variant-A.html");
  });

  it("restores decisions from localStorage on mount", () => {
    localStorage.setItem("ai-studio.decisions", JSON.stringify({ g2: { status: "approved", at: "2026-11-09T10:00:00Z" } }));
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    expect(screen.getByText("Gates · 3 awaiting you")).toBeInTheDocument();
  });
});

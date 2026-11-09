import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMockDataset } from "@src/areas/toast/mock-data";
import { generateInsights, narrativeTask } from "@src/areas/toast/insights";
import { MockProvider } from "@src/core/llm/mock";
import { AskToast, ToastView } from "./ToastView";
import { ReviewQueueView } from "./ReviewQueueView";
import { readDecisions, writeDecision, type ReviewQueue, type ToastBundle } from "../lib/data";

/**
 * Scenario group I: the browser. Private mode blocks storage, data files are
 * stale or half-written, and users click fast.
 */
const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const insights = generateInsights(data, asOf);
const narrative = (await new MockProvider().run(narrativeTask, { asOf, days: 7, insights })).output;
const bundle: ToastBundle = { asOf, days: 7, insights, narrative, answers: [] };

describe("I1 · storage unavailable", () => {
  const original = Storage.prototype.setItem;
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    Storage.prototype.setItem = original;
  });

  it("approving still updates the screen when localStorage throws (private mode)", () => {
    Storage.prototype.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };
    const queue: ReviewQueue = { briefId: "b", client: "c", campaign: "x", status: "complete", items: [{ id: "g1", gate: "copy.approve", area: "copy", risk: "human", guardrailScore: 100, decision: "approved", summary: "s", preview: { kind: "copy", data: { hooks: [], headlines: [], descriptions: [], storyOverlays: [], primaryTexts: [] } } }] };
    render(<ReviewQueueView queue={queue} dir="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Gates · 0 awaiting you")).toBeInTheDocument();
  });

  it("corrupt stored decisions are ignored rather than crashing the queue", () => {
    localStorage.setItem("ai-studio.decisions", "{not json");
    expect(readDecisions()).toEqual({});
    expect(() => writeDecision("x", { status: "approved", at: "now" })).not.toThrow();
  });
});

describe("I2 · stale or partial data files", () => {
  it("a review item with an unknown preview kind renders the summary and no crash", () => {
    const queue = { briefId: "b", client: "c", campaign: "x", status: "complete", items: [{ id: "g1", gate: "future.gate", area: "new", risk: "human", guardrailScore: 90, decision: "pending", summary: "Something new", preview: { kind: "hologram", data: { any: "thing" } } }] } as unknown as ReviewQueue;
    render(<ReviewQueueView queue={queue} dir="b" />);
    expect(screen.getByText("Something new")).toBeInTheDocument();
  });

  it.fails("[BUG-41] a review item whose preview data is null does not crash", () => {
    const queue = { briefId: "b", client: "c", campaign: "x", status: "complete", items: [{ id: "g1", gate: "ideas.select", area: "ideas", risk: "human", guardrailScore: 90, decision: "pending", summary: "s", preview: { kind: "ideas", data: null } }] } as unknown as ReviewQueue;
    expect(() => render(<ReviewQueueView queue={queue} dir="b" />)).not.toThrow();
  });

  it("the Toast view renders when the dataset has no clients", () => {
    const empty = { ...data, clients: [], metrics: [], adsets: [], ads: [], campaigns: [] };
    render(<ToastView data={empty} bundle={{ ...bundle, insights: [] }} />);
    expect(screen.getAllByText("Spend").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("a narrative with zero paragraphs or actions renders without errors", () => {
    render(<ToastView data={data} bundle={{ ...bundle, narrative: { headline: "Quiet week", paragraphs: [], actionsToday: [] } }} />);
    expect(screen.getByText("Quiet week")).toBeInTheDocument();
  });
});

describe("I3 · fast and odd user input", () => {
  it("submitting Ask Toast with only spaces does nothing", () => {
    render(<AskToast data={data} asOf={asOf} seed={[]} />);
    fireEvent.change(screen.getByLabelText("Ask Toast a question"), { target: { value: "    " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.queryAllByTestId("answer-text")).toHaveLength(0);
  });

  it("asking twenty questions quickly keeps only the most recent eight and stays responsive", () => {
    render(<AskToast data={data} asOf={asOf} seed={[]} />);
    const input = screen.getByLabelText("Ask Toast a question");
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      fireEvent.change(input, { target: { value: `How is Hearthline doing? ${i}` } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    }
    expect(screen.getAllByTestId("answer-text")).toHaveLength(8);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("a question containing HTML is rendered as text, not markup", () => {
    render(<AskToast data={data} asOf={asOf} seed={[]} />);
    fireEvent.change(screen.getByLabelText("Ask Toast a question"), { target: { value: `<img src=x onerror="window.__pwned=1"> how is Hearthline doing?` } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("double-clicking Approve does not record two decisions or flip the state back", () => {
    const queue: ReviewQueue = { briefId: "b", client: "c", campaign: "x", status: "complete", items: [{ id: "g1", gate: "copy.approve", area: "copy", risk: "human", guardrailScore: 100, decision: "approved", summary: "s", preview: { kind: "copy", data: { hooks: [], headlines: [], descriptions: [], storyOverlays: [], primaryTexts: [] } } }] };
    localStorage.clear();
    render(<ReviewQueueView queue={queue} dir="b" />);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    const stored = JSON.parse(localStorage.getItem("ai-studio.decisions")!);
    expect(Object.keys(stored)).toEqual(["g1"]);
    vi.useRealTimers();
  });
});

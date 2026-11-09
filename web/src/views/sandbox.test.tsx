import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportsView } from "./ReportsView";
import { ReviewQueueView } from "./ReviewQueueView";
import type { ReportsIndex, ReviewQueue } from "../lib/data";

describe("generated HTML previews are sandboxed (SEC-07)", () => {
  it("report iframes cannot run scripts", () => {
    const index: ReportsIndex = { asOf: "2026-11-08", reports: [{ clientId: "hearthline", clientName: "Hearthline", headline: "Good week", verified: true, html: "reports/hearthline.html" }] };
    render(<ReportsView index={index} drafts={[]} />);
    const frame = screen.getByTitle("Report for Hearthline");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("landing page iframes allow forms and the page's own script but nothing else", () => {
    const queue = {
      briefId: "brief-1",
      client: "Hearthline",
      campaign: "Winter Warmth",
      status: "complete",
      items: [
        { id: "g4", gate: "landing.approve", area: "landing", risk: "human", guardrailScore: 100, decision: "approved", summary: "1/1 pass", preview: { kind: "landing", data: [{ variant: "A", html: "07-landing/variant-A.html", headline: "Keep one neighbour warm", hypothesis: "Control", ok: true, score: 100 }] } },
      ],
    } as unknown as ReviewQueue;
    render(<ReviewQueueView queue={queue} dir="brief-1" />);
    fireEvent.click(screen.getByText("landing.approve"));
    const frame = screen.getByTitle("Landing variant A");
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).sort();
    expect(tokens).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(tokens).not.toContain("allow-top-navigation");
    expect(tokens).not.toContain("allow-popups");
  });
});

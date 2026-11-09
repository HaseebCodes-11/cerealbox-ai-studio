import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ReportsView } from "./ReportsView";
import type { CommsDraftRecord, ReportsIndex } from "../lib/data";

const index: ReportsIndex = {
  asOf: "2026-11-08",
  reports: [
    { clientId: "hearthline", clientName: "Hearthline", headline: "Hearthline: £5,853 raised, ahead of target", verified: true, html: "reports/hearthline.html" },
    { clientId: "bluewater", clientName: "Bluewater Trust", headline: "Bluewater Trust: £1,822 raised, working to get back to target", verified: false, html: "reports/bluewater.html" },
  ],
};

const drafts: CommsDraftRecord[] = [
  { question: { id: "q1", clientId: "hearthline", from: "Marie", receivedAt: "2026-11-09", text: "How are the ads doing?" }, reply: { category: "performance", subject: "Re: How are the ads doing", reply: "Hi Marie,\n\nGood question. You raised £5,853.\n\nBest wishes,\nHaseeb", factsUsed: ["revenue"], needsHumanInput: false, confidence: 0.85 }, guardrails: { ok: true, issues: [] }, numbers: { ok: true, unverified: [] }, risk: "approve" },
  { question: { id: "q2", clientId: "northlight", from: "Ian", receivedAt: "2026-11-08", text: "The invoice doesn't match." }, reply: { category: "billing", subject: "Re: invoice", reply: "Hi Ian,\n\nChecking with finance.\n\nBest wishes,\nHaseeb", factsUsed: [], needsHumanInput: true, escalationReason: "Billing needs finance.", confidence: 0.95 }, guardrails: { ok: true, issues: [] }, numbers: { ok: true, unverified: [] }, risk: "human" },
];

describe("ReportsView", () => {
  beforeEach(() => localStorage.clear());

  it("lists reports with verification badges and shows the selected report in an iframe", () => {
    render(<ReportsView index={index} drafts={drafts} />);
    expect(screen.getByText("figures verified")).toBeInTheDocument();
    expect(screen.getByText("needs review")).toBeInTheDocument();
    expect(screen.getByTitle("Report for Hearthline")).toHaveAttribute("src", "/reports/hearthline.html");
    fireEvent.click(screen.getByText("Bluewater Trust", { selector: "span" }));
    expect(screen.getByTitle("Report for Bluewater Trust")).toHaveAttribute("src", "/reports/bluewater.html");
    fireEvent.change(screen.getByLabelText("Client report"), { target: { value: "hearthline" } });
    expect(screen.getByTitle("Report for Hearthline")).toBeInTheDocument();
  });

  it("shows drafts with risk tiers; only ready-to-send drafts get an approve button", () => {
    render(<ReportsView index={index} drafts={drafts} />);
    expect(screen.getByText("ready to send")).toBeInTheDocument();
    expect(screen.getByText("needs a human")).toBeInTheDocument();
    expect(screen.getByText(/Escalation: Billing needs finance/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve q1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve q2" })).toBeNull();
    expect(screen.getByTestId("draft-q1").textContent).toContain("£5,853");
  });

  it("approving a draft persists and replaces the buttons", () => {
    render(<ReportsView index={index} drafts={drafts} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve q1" }));
    expect(screen.getByText("approved to send")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ai-studio.decisions")!)["comms:q1"].status).toBe("approved");
    expect(screen.queryByRole("button", { name: "Approve q1" })).toBeNull();
  });

  it("handles empty data", () => {
    render(<ReportsView index={{ asOf: "2026-11-08", reports: [] }} drafts={[]} />);
    expect(screen.getByText(/No reports yet/)).toBeInTheDocument();
    expect(screen.getByText(/No drafts/)).toBeInTheDocument();
  });
});

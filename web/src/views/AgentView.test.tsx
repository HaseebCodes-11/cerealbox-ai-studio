import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { generateMockDataset } from "@src/areas/toast/mock-data";
import { MockMetaAdsClient, runMediaBuyerAgent } from "@src/areas/media-buyer/agent";
import { MockProvider } from "@src/core/llm/mock";
import { AgentView } from "./AgentView";
import type { AgentRun } from "../lib/data";

const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const result = await runMediaBuyerAgent({ data, asOf, provider: new MockProvider(), adsClient: new MockMetaAdsClient(), autonomy: "copilot", dryRun: true });
const run: AgentRun = { asOf, autonomy: "copilot", dryRun: true, recommendations: result.recommendations, alerts: result.alerts, briefs: result.briefs, actions: result.actions };

describe("AgentView", () => {
  beforeEach(() => localStorage.clear());

  it("shows the autonomy ladder with the current level highlighted, alerts and briefs", () => {
    render(<AgentView run={run} />);
    expect(screen.getByText(/running as copilot \(dry run\)/)).toBeInTheDocument();
    expect(screen.getByText(`Alerts (${run.alerts.length})`)).toBeInTheDocument();
    for (const b of run.briefs) expect(screen.getByText(b.brief.headline)).toBeInTheDocument();
    expect(screen.getByText(`Recommendations for ${asOf} (${run.recommendations.length})`)).toBeInTheDocument();
  });

  it("filters recommendations by risk tier", () => {
    render(<AgentView run={run} />);
    const human = run.recommendations.filter((r) => r.risk === "human").length;
    fireEvent.click(screen.getByRole("button", { name: "human" }));
    expect(screen.getByText(`Recommendations for ${asOf} (${human})`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "human" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(screen.getByText(/No recommendations at this risk tier/)).toBeInTheDocument();
  });

  it("approves and rejects recommendations locally; investigate-only items have no buttons", () => {
    render(<AgentView run={run} />);
    const withChange = run.recommendations.find((r) => r.proposedChange)!;
    fireEvent.click(screen.getByRole("button", { name: `Approve ${withChange.id}` }));
    expect(JSON.parse(localStorage.getItem("ai-studio.decisions")!)[`rec:${withChange.id}`].status).toBe("approved");
    const tracking = run.recommendations.find((r) => r.rule === "tracking-break")!;
    expect(screen.queryByRole("button", { name: `Approve ${tracking.id}` })).toBeNull();
    expect(screen.getAllByText("investigate").length).toBeGreaterThan(0);
  });
});

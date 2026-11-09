import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { generateMockDataset } from "@src/areas/toast/mock-data";
import { generateInsights, narrativeTask } from "@src/areas/toast/insights";
import { MockProvider } from "@src/core/llm/mock";
import { AskToast, ToastView } from "./ToastView";
import type { ToastBundle } from "../lib/data";

const asOf = "2026-11-08";
const data = generateMockDataset({ asOf });
const insights = generateInsights(data, asOf);
const narrative = (await new MockProvider().run(narrativeTask, { asOf, days: 7, insights })).output;
const bundle: ToastBundle = { asOf, days: 7, insights, narrative, answers: [] };

describe("ToastView", () => {
  it("renders KPIs, every client, the narrative and insights", () => {
    render(<ToastView data={data} bundle={bundle} />);
    for (const label of ["Spend", "Revenue", "ROAS", "Donations", "CPA", "Avg gift"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    for (const c of data.clients) expect(screen.getAllByText(c.name).length).toBeGreaterThan(0);
    expect(screen.getByText(narrative.headline)).toBeInTheDocument();
    expect(screen.getByText(`Insights (${insights.length})`)).toBeInTheDocument();
    expect(screen.getByText(insights[0]!.title)).toBeInTheDocument();
    expect(screen.getByText(/Spend vs revenue/)).toBeInTheDocument();
  });

  it("shows the critical tracking insight with its badge", () => {
    render(<ToastView data={data} bundle={bundle} />);
    const critical = screen.getAllByText("critical");
    expect(critical.length).toBeGreaterThan(0);
    expect(screen.getByText(/Zero donations recorded on OC - Interests Marine/)).toBeInTheDocument();
  });
});

describe("AskToast", () => {
  it("answers a typed question from the data and lists its sources", () => {
    render(<AskToast data={data} asOf={asOf} seed={[]} />);
    const input = screen.getByLabelText("Ask Toast a question");
    fireEvent.change(input, { target: { value: "Which client had the biggest ROAS drop last week?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const answer = screen.getByTestId("answer-text");
    expect(answer.textContent).toMatch(/biggest ROAS deterioration/);
    expect(screen.getByText(/intent: biggest_change/)).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("suggested questions work and newest answers come first", () => {
    render(<AskToast data={data} asOf={asOf} seed={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Do video or static creatives perform better?" }));
    fireEvent.click(screen.getByRole("button", { name: "Anything unusual this week?" }));
    const answers = screen.getAllByTestId("answer-text");
    expect(answers).toHaveLength(2);
    expect(answers[0]!.textContent).toMatch(/zero donations for 3 days|Nothing unusual/);
    expect(answers[1]!.textContent).toMatch(/By creative type/);
  });

  it("renders seeded answers with their tables", () => {
    const seed = [{ question: "q", intent: { intent: "rank_clients" as const, metric: "cpa" as const, direction: "down" as const, days: 7, limit: 2 }, text: "Worst clients by CPA", table: { columns: ["Client", "CPA"], rows: [["A", 10], ["B", 12]] }, sources: ["aggregate"] }];
    render(<AskToast data={data} asOf={asOf} seed={seed} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Worst clients by CPA")).toBeInTheDocument();
  });
});

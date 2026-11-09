import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/core/llm";
import { CHART_JS_SRI, generateInsights, generateMockDataset, narrativeTask, renderDashboard } from "../../src/areas/toast";

describe("Toast dashboard third-party script (SEC-05)", () => {
  it("loads Chart.js with a well-formed SHA-384 integrity attribute and crossorigin", async () => {
    const asOf = "2026-11-08";
    const data = generateMockDataset({ asOf });
    const insights = generateInsights(data, asOf);
    const narrative = (await new MockProvider().run(narrativeTask, { asOf, days: 7, insights })).output;
    const html = renderDashboard({ data, asOf, insights, narrative });
    const tags = [...html.matchAll(/<script[^>]*src="(https?:[^"]+)"[^>]*>/g)];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag[0]).toMatch(/integrity="sha384-[A-Za-z0-9+/]{64}"/);
      expect(tag[0]).toMatch(/crossorigin="anonymous"/);
    }
    expect(CHART_JS_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(html).toContain(`integrity="${CHART_JS_SRI}"`);
  });
});

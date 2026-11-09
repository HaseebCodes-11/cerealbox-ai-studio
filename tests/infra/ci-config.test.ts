import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CI configuration (SEC-06)", () => {
  const workflow = readFileSync(".github/workflows/verify.yml", "utf8");

  it("runs the token with read-only permissions", () => {
    expect(workflow).toMatch(/^permissions:\n\s+contents: read/m);
  });

  it("uses the pinned Node version from .nvmrc", () => {
    expect(existsSync(".nvmrc")).toBe(true);
    expect(readFileSync(".nvmrc", "utf8").trim()).toMatch(/^\d+$/);
    expect(workflow).toMatch(/node-version-file: \.nvmrc/);
  });

  it("never references the secrets context in a step-level if", () => {
    for (const line of workflow.split("\n")) if (/^\s+if:/.test(line)) expect(line).not.toMatch(/secrets\./);
  });

  it("has Dependabot configured for npm and actions", () => {
    const dependabot = readFileSync(".github/dependabot.yml", "utf8");
    expect(dependabot).toMatch(/package-ecosystem: npm/);
    expect(dependabot).toMatch(/package-ecosystem: github-actions/);
  });
});

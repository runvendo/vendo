import { describe, expect, it } from "vitest";
import { buildInstallEvalReport, renderInstallEvalMarkdown, REPORT_FOOTER_RULE } from "./report.js";
import type { FixtureRunMetrics } from "./score.js";

function metrics(overrides: Partial<FixtureRunMetrics>): FixtureRunMetrics {
  return {
    fixture: "express-host",
    doctor: { ran: true, green: true, failingCodes: [] },
    turns: 12,
    turnBudget: 40,
    withinTurnBudget: true,
    costUsd: 2.31,
    durationMs: 480_000,
    askedBeforeAccount: { pass: true, accountActions: [], askEvidence: [] },
    violations: [],
    agentExit: { code: 0, timedOut: false },
    ...overrides,
  };
}

describe("install-eval report", () => {
  it("renders the matrix, failure detail, and the spec footer rule", () => {
    const doc = buildInstallEvalReport({
      generatedAt: "2026-07-19T00:00:00.000Z",
      runId: "2026-07-19T00-00-00-000Z",
      mode: "live",
      model: "sonnet",
      promptSource: "docs-site/install.mdx",
      prompt: "Install Vendo in this repo.",
      fixtures: [
        metrics({}),
        metrics({
          fixture: "demo-bank",
          doctor: { ran: true, green: false, failingCodes: ["E-WIRE-004", "E-TURN-001"] },
          askedBeforeAccount: { pass: false, accountActions: ["Bash: npx vendo cloud login"], askEvidence: [] },
          violations: [{ id: "skipped-star-ask", detail: "transcript never asks about starring" }],
        }),
      ],
    });

    expect(doc.summary).toEqual({ fixtureCount: 2, doctorGreen: 1, cleanRuns: 1 });

    const markdown = renderInstallEvalMarkdown(doc);
    expect(markdown).toContain("| express-host | yes | 12/40 | yes | none | 2.31 | 480s |");
    expect(markdown).toContain("NO (E-WIRE-004, E-TURN-001)");
    expect(markdown).toContain("## demo-bank — failure detail");
    expect(markdown).toContain("npx vendo cloud login");
    expect(markdown).toContain(REPORT_FOOTER_RULE);
    expect(REPORT_FOOTER_RULE).toContain("doctor error code");
    expect(REPORT_FOOTER_RULE).toContain("verify");
  });

  it("labels dry runs as canned", () => {
    const doc = buildInstallEvalReport({
      generatedAt: "2026-07-19T00:00:00.000Z",
      runId: "run",
      mode: "dry-run",
      model: "sonnet",
      promptSource: "docs-site/install.mdx",
      prompt: "p",
      fixtures: [metrics({})],
    });
    expect(renderInstallEvalMarkdown(doc)).toContain("canned transcript — no agent was invoked");
  });
});

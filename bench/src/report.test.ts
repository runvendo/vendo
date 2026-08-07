import { describe, expect, it } from "vitest";
import { buildReport, checkSummary, failureSummary, suiteTables, textSummary } from "./report.js";
import type { SuiteResult } from "./types.js";

const results: SuiteResult[] = [
  {
    suite: "tree-validate",
    kind: "deterministic",
    cases: [{ name: "nodes-10", unit: "ms", samples: 200, p50: 0.01, p95: 0.02, min: 0.008, max: 0.05 }],
  },
  { suite: "gen-live", kind: "live", cases: [], skipped: true, reason: "ANTHROPIC_API_KEY not set" },
];

describe("buildReport", () => {
  it("wraps suites with machine/date/node metadata", () => {
    const report = buildReport(results);
    expect(report.suites).toBe(results);
    expect(report.node).toBe(process.version);
    expect(report.machine).toContain(process.platform);
    expect(() => new Date(report.date).toISOString()).not.toThrow();
  });
});

describe("suiteTables", () => {
  it("renders a table per non-skipped suite and a note for skipped", () => {
    const md = suiteTables(results);
    expect(md).toContain("### tree-validate (deterministic)");
    expect(md).toContain("| nodes-10 | 200 |");
    expect(md).toContain("_skipped — ANTHROPIC_API_KEY not set_");
  });
});

describe("textSummary", () => {
  it("emits one line per metric and a SKIP line", () => {
    const text = textSummary(results);
    expect(text).toContain("tree-validate:nodes-10");
    expect(text).toContain("SKIP  gen-live");
  });
});

describe("checkSummary", () => {
  it("reports PASS with no breaches and no unmatched ceilings", () => {
    expect(checkSummary(results, [], [])).toContain("Perf budgets: PASS");
  });

  it("reports FAIL and a breach table", () => {
    const md = checkSummary(results, [{ key: "tree-validate:nodes-10", measuredP95: 9, ceiling: 5 }]);
    expect(md).toContain("Perf budgets: FAIL (1 breach)");
    expect(md).toContain("| tree-validate:nodes-10 | 9.00 | 5.00 |");
  });

  it("reports FAIL for unmatched ceiling keys even with zero breaches", () => {
    const md = checkSummary(results, [], ["store:put-renamed"]);
    expect(md).toContain("Perf budgets: FAIL (1 unmatched ceiling)");
    expect(md).toContain("- `store:put-renamed`");
    expect(md).toContain("dead config");
  });

  it("reports both breaches and unmatched ceilings in the header", () => {
    const md = checkSummary(
      results,
      [{ key: "tree-validate:nodes-10", measuredP95: 9, ceiling: 5 }],
      ["store:put-renamed", "store:get-renamed"],
    );
    expect(md).toContain("Perf budgets: FAIL (1 breach, 2 unmatched ceilings)");
  });
});

describe("failureSummary", () => {
  it("names the failing suite and includes the error message", () => {
    const md = failureSummary("store", new Error("PGlite exploded"));
    expect(md).toContain("Perf bench: ERROR");
    expect(md).toContain("in suite `store`");
    expect(md).toContain("PGlite exploded");
  });

  it("handles a failure before any suite ran", () => {
    const md = failureSummary(undefined, "bad args");
    expect(md).toContain("before any suite ran");
    expect(md).toContain("bad args");
  });
});

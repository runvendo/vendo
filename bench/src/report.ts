import type { BenchReport, SuiteResult } from "./types.js";
import type { Breach } from "./budgets.js";

/** Build the JSON report envelope for a set of suite results. */
export function buildReport(suites: SuiteResult[]): BenchReport {
  return {
    machine: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
    node: process.version,
    suites,
  };
}

const cell = (value: number): string => value.toFixed(2);

/** One markdown table per suite; skipped suites render a one-line note. */
export function suiteTables(suites: readonly SuiteResult[]): string {
  const blocks: string[] = [];
  for (const suite of suites) {
    blocks.push(`### ${suite.suite} (${suite.kind})`);
    if (suite.skipped) {
      blocks.push(`_skipped — ${suite.reason ?? "no reason given"}_`);
      continue;
    }
    for (const note of suite.notes ?? []) blocks.push(`> ${note}`);
    blocks.push("| case | samples | p50 (ms) | p95 (ms) | min | max |");
    blocks.push("| --- | --- | --- | --- | --- | --- |");
    for (const c of suite.cases) {
      blocks.push(
        `| ${c.name} | ${c.samples} | ${cell(c.p50)} | ${cell(c.p95)} | ${cell(c.min)} | ${cell(c.max)} |`,
      );
    }
  }
  return blocks.join("\n");
}

/** A compact one-line-per-metric summary for terminal output. */
export function textSummary(suites: readonly SuiteResult[]): string {
  const lines: string[] = [];
  for (const suite of suites) {
    if (suite.skipped) {
      lines.push(`SKIP  ${suite.suite}: ${suite.reason ?? "no reason"}`);
      continue;
    }
    for (const c of suite.cases) {
      lines.push(
        `      ${suite.suite}:${c.name}  p50=${cell(c.p50)}ms  p95=${cell(c.p95)}ms  (n=${c.samples})`,
      );
    }
  }
  return lines.join("\n");
}

/** Markdown for the CI step summary: the tables plus a pass/breach/dead-config verdict. */
export function checkSummary(
  suites: readonly SuiteResult[],
  breaches: readonly Breach[],
  unmatchedCeilings: readonly string[] = [],
): string {
  const failed = breaches.length > 0 || unmatchedCeilings.length > 0;
  const failParts = [
    ...(breaches.length > 0 ? [`${breaches.length} breach${breaches.length === 1 ? "" : "es"}`] : []),
    ...(unmatchedCeilings.length > 0
      ? [`${unmatchedCeilings.length} unmatched ceiling${unmatchedCeilings.length === 1 ? "" : "s"}`]
      : []),
  ];
  const header = failed
    ? `## Perf budgets: FAIL (${failParts.join(", ")})`
    : "## Perf budgets: PASS\n\nAll gated p95 metrics are within budget.";
  const breachTable = breaches.length === 0
    ? ""
    : [
        "",
        "| metric | measured p95 (ms) | ceiling (ms) |",
        "| --- | --- | --- |",
        ...breaches.map((b) => `| ${b.key} | ${cell(b.measuredP95)} | ${cell(b.ceiling)} |`),
      ].join("\n");
  const unmatchedBlock = unmatchedCeilings.length === 0
    ? ""
    : [
        "",
        "Ceiling keys in budgets.json matched by no measured case — dead config; a suite or case was renamed or deleted without updating budgets.json:",
        ...unmatchedCeilings.map((key) => `- \`${key}\``),
      ].join("\n");
  return `${header}${breachTable}${unmatchedBlock}\n\n${suiteTables(suites)}\n`;
}

/** Markdown for the CI step summary when the run itself throws (infra failure, not a breach). */
export function failureSummary(suiteName: string | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const where = suiteName === undefined ? "before any suite ran" : `in suite \`${suiteName}\``;
  return `## Perf bench: ERROR\n\nThe bench run failed ${where} (harness/infra failure, not a budget breach):\n\n\`\`\`\n${message}\n\`\`\`\n`;
}

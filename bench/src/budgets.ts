import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SuiteResult } from "./types.js";

/**
 * budgets.json shape. Ceilings are keyed "<suite>:<case>" and are the maximum
 * allowed p95 (ms) for that metric. Only deterministic suites are gated.
 */
export interface BudgetsFile {
  toleranceRationale: string;
  ceilings: Record<string, number>;
}

export interface Breach {
  key: string;
  measuredP95: number;
  ceiling: number;
}

export const budgetKey = (suite: string, caseName: string): string => `${suite}:${caseName}`;

/** Load bench/budgets.json (resolved relative to the built module, not cwd). */
export async function loadBudgets(): Promise<BudgetsFile> {
  const path = fileURLToPath(new URL("../budgets.json", import.meta.url));
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as BudgetsFile;
}

/**
 * Compare measured suites against the budget ceilings. A case whose p95 exceeds
 * its ceiling is a breach; cases without a ceiling are ignored (not every metric
 * is gated). Skipped suites contribute nothing.
 */
export function findBreaches(suites: readonly SuiteResult[], budgets: BudgetsFile): Breach[] {
  const breaches: Breach[] = [];
  for (const suite of suites) {
    if (suite.skipped) continue;
    for (const result of suite.cases) {
      const key = budgetKey(suite.suite, result.name);
      const ceiling = budgets.ceilings[key];
      if (ceiling === undefined) continue;
      if (result.p95 > ceiling) {
        breaches.push({ key, measuredP95: result.p95, ceiling });
      }
    }
  }
  return breaches;
}

/**
 * Gate integrity: every ceiling key must match a measured case, otherwise a
 * renamed or deleted suite/case silently turns its budget into dead config and
 * the gate stops gating. Returns the ceiling keys matched by no measured
 * (non-skipped) case; a full-set `--check` fails when any exist.
 */
export function findUnmatchedCeilings(
  suites: readonly SuiteResult[],
  budgets: BudgetsFile,
): string[] {
  const measured = new Set<string>();
  for (const suite of suites) {
    if (suite.skipped) continue;
    for (const result of suite.cases) measured.add(budgetKey(suite.suite, result.name));
  }
  return Object.keys(budgets.ceilings).filter((key) => !measured.has(key));
}

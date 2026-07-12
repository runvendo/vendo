import { describe, expect, it } from "vitest";
import {
  budgetKey,
  findBreaches,
  findUnmatchedCeilings,
  loadBudgets,
  type BudgetsFile,
} from "./budgets.js";
import { DETERMINISTIC_SUITES } from "./benches/index.js";
import type { SuiteResult } from "./types.js";

const suite = (name: string, cases: SuiteResult["cases"]): SuiteResult => ({
  suite: name,
  kind: "deterministic",
  cases,
});

const metric = (name: string, p95: number): SuiteResult["cases"][number] => ({
  name,
  unit: "ms",
  samples: 10,
  p50: p95 / 2,
  p95,
  min: 0,
  max: p95,
});

const budgets: BudgetsFile = {
  toleranceRationale: "test",
  ceilings: { "tree-validate:nodes-10": 5, "store:put-pglite": 10 },
};

describe("findBreaches", () => {
  it("flags a metric whose p95 exceeds its ceiling", () => {
    const results = [suite("tree-validate", [metric("nodes-10", 8)])];
    const breaches = findBreaches(results, budgets);
    expect(breaches).toEqual([{ key: "tree-validate:nodes-10", measuredP95: 8, ceiling: 5 }]);
  });

  it("passes a metric at or under its ceiling", () => {
    const results = [suite("tree-validate", [metric("nodes-10", 5)])];
    expect(findBreaches(results, budgets)).toEqual([]);
  });

  it("ignores metrics without a ceiling", () => {
    const results = [suite("tree-validate", [metric("nodes-99999", 9999)])];
    expect(findBreaches(results, budgets)).toEqual([]);
  });

  it("skips skipped suites", () => {
    const results: SuiteResult[] = [
      { suite: "store", kind: "deterministic", cases: [metric("put-pglite", 999)], skipped: true, reason: "x" },
    ];
    expect(findBreaches(results, budgets)).toEqual([]);
  });
});

describe("findUnmatchedCeilings", () => {
  it("returns ceiling keys matched by no measured case (dead config)", () => {
    // Only tree-validate ran; the store ceiling has no measured counterpart.
    const results = [suite("tree-validate", [metric("nodes-10", 1)])];
    expect(findUnmatchedCeilings(results, budgets)).toEqual(["store:put-pglite"]);
  });

  it("returns nothing when every ceiling key is measured", () => {
    const results = [
      suite("tree-validate", [metric("nodes-10", 1)]),
      suite("store", [metric("put-pglite", 1)]),
    ];
    expect(findUnmatchedCeilings(results, budgets)).toEqual([]);
  });

  it("does not let a skipped suite's cases satisfy a ceiling", () => {
    const results: SuiteResult[] = [
      suite("tree-validate", [metric("nodes-10", 1)]),
      { suite: "store", kind: "deterministic", cases: [metric("put-pglite", 1)], skipped: true, reason: "x" },
    ];
    expect(findUnmatchedCeilings(results, budgets)).toEqual(["store:put-pglite"]);
  });

  it("flags a renamed case as unmatched", () => {
    const results = [
      suite("tree-validate", [metric("nodes-10-renamed", 1)]),
      suite("store", [metric("put-pglite", 1)]),
    ];
    expect(findUnmatchedCeilings(results, budgets)).toEqual(["tree-validate:nodes-10"]);
  });
});

describe("committed budgets.json integrity", () => {
  it("every ceiling key's suite prefix is a registered deterministic suite", async () => {
    const file = await loadBudgets();
    const suiteNames = new Set(DETERMINISTIC_SUITES.map((s) => s.name));
    for (const key of Object.keys(file.ceilings)) {
      const prefix = key.split(":")[0];
      expect(suiteNames, `ceiling "${key}" names an unregistered suite`).toContain(prefix);
    }
  });
});

describe("budgetKey", () => {
  it("joins suite and case with a colon", () => {
    expect(budgetKey("store", "put-pglite")).toBe("store:put-pglite");
  });
});

describe("loadBudgets", () => {
  it("loads the committed budgets.json with ceilings", async () => {
    const file = await loadBudgets();
    expect(typeof file.toleranceRationale).toBe("string");
    expect(Object.keys(file.ceilings).length).toBeGreaterThan(0);
    for (const value of Object.values(file.ceilings)) expect(typeof value).toBe("number");
  });
});

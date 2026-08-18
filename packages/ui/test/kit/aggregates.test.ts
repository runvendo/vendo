import {
  type Json,
} from "@vendoai/core";
import {
  evaluateExpr,
  warmExprRuntime,
} from "@vendoai/apps/contract";
import { beforeAll, describe, expect, it } from "vitest";
import { average, count, daysUntil, difference, groupBy, max, min, sum } from "../../src/kit/aggregates.js";

const invoices = [
  { amount_cents: 12_000, issued_at: "2026-01-14T00:00:00.000Z" },
  { amount_cents: 8_000, issued_at: "2026-01-28T00:00:00.000Z" },
  { amount_cents: 30_000, issued_at: "2026-02-03T00:00:00.000Z" },
];

describe("the aggregates read naturally in code-land", () => {
  it("reduces a column of a row list", () => {
    expect(sum(invoices, "amount_cents")).toBe(50_000);
    expect(average(invoices, "amount_cents")).toBe(50_000 / 3);
    expect(min(invoices, "amount_cents")).toBe(8_000);
    expect(max(invoices, "amount_cents")).toBe(30_000);
    expect(count(invoices)).toBe(3);
    expect(difference(30_000, 8_000)).toBe(22_000);
  });

  it("counts days to a date against a fixed now, so it is testable", () => {
    expect(daysUntil("2026-01-14T00:00:00.000Z", { now: Date.parse("2026-01-04T00:00:00.000Z") })).toBe(10);
  });

  it("buckets a date column and aggregates the same rows", () => {
    expect(groupBy(invoices, "issued_at", "month", "sum", "amount_cents")).toEqual([
      { key: "2026-01", value: 20_000 },
      { key: "2026-02", value: 30_000 },
    ]);
    expect(groupBy(invoices, "issued_at", "month", "count")).toEqual([
      { key: "2026-01", value: 2 },
      { key: "2026-02", value: 1 },
    ]);
  });

  it("passes loading through and degrades a mismatch to undefined", () => {
    expect(sum(undefined, "amount_cents")).toBeUndefined();
    expect(count(undefined)).toBeUndefined();
    expect(groupBy(undefined, "issued_at", "month", "count")).toBeUndefined();
    // a field the rows do not carry, and a field that is not numeric
    expect(sum(invoices, "nope")).toBeUndefined();
    expect(sum(invoices, "issued_at")).toBeUndefined();
    // a field name outside the expression grammar can never smuggle in syntax
    expect(sum(invoices, "amount_cents) + sum(invoices.amount_cents")).toBeUndefined();
    expect(count("not a list" as unknown as Json)).toBeUndefined();
    expect(daysUntil("not a date")).toBeUndefined();
  });

  it("skips the rows that carry no number instead of erasing the column", () => {
    // What this closes: ONE bad cell degraded the whole reduction to undefined,
    // so a single "n/a" in a 500-row amount column erased the total the other
    // 499 rows agreed on. A host that writes null for some rows and omits the
    // key in others is the ordinary case, not a broken one.
    const dirty: Json = [
      { amount_cents: 12_000 },
      { amount_cents: "n/a" },
      { amount_cents: null },
      {},
      { amount_cents: 8_000 },
    ];
    expect(sum(dirty, "amount_cents")).toBe(20_000);
    expect(average(dirty, "amount_cents")).toBe(10_000);
    expect(min(dirty, "amount_cents")).toBe(8_000);
    expect(max(dirty, "amount_cents")).toBe(12_000);
    // And the other half of the rule: rows were rejected and not one of them
    // yielded a number, so there is no answer — `sum(rows, "nope")` as 0 is a
    // wrong number that reads as real.
    expect(sum(invoices, "nope")).toBeUndefined();
    expect(sum(invoices, "issued_at")).toBeUndefined();
  });

  it("answers empty rows the way the expression engine does", () => {
    expect(sum([], "amount_cents")).toBe(0);
    expect(count([])).toBe(0);
    // A column of nothing but nulls is emptiness in the DATA, not a mislabelled
    // field: the reduce a screen writes by hand answers 0 there, so this does.
    expect(sum([{ amount_cents: null }], "amount_cents")).toBe(0);
    expect(average([], "amount_cents")).toBeUndefined();
    expect(groupBy([], "issued_at", "month", "count")).toEqual([]);
  });
});

/**
 * THE SEAM: `sum(rows, "amount")` here and the plain-JavaScript reduce a screen
 * writes in a `{…}` gap are the same language reaching the same arithmetic
 * (kit/aggregates.ts §doc), so they must agree to the digit. Each wrapper is
 * asserted against `evaluateExpr` — the real sealed QuickJS VM a screen's
 * `$expr` runs in, no stub on either side — over the hand-written expression a
 * screen would use instead of the wrapper. Give the shim its own reduce and
 * these go red.
 *
 * Only the cases where JavaScript HAS an equivalent live here. The wrappers'
 * degradations (a non-numeric column, a mislabelled field, no clock) are the
 * kit's own posture, not shared arithmetic, and are asserted above.
 */
describe("the aggregates agree with the same arithmetic in a real $expr", () => {
  const rows: Json = [
    { amount: 10, when: "2026-03-01T00:00:00.000Z" },
    { amount: -4.5, when: "2026-03-09T00:00:00.000Z" },
    { amount: null, when: "2026-04-02T00:00:00.000Z" },
  ];
  const empty: Json = [];

  // Evaluation is synchronous, but the VM behind it boots once, asynchronously —
  // an expression evaluated before the boot lands reads as `undefined`, which
  // would make every comparison below pass against nothing.
  beforeAll(async () => {
    await warmExprRuntime();
  });

  /** The rows the kit's `column` keeps: an explicit null is sparse data, so a
   *  screen writing the reduce by hand filters the same way. */
  const NUMERIC = 'v.filter((r) => typeof r.amount === "number")';
  const SUM = `${NUMERIC}.reduce((total, r) => total + r.amount, 0)`;
  /** The distinct `YYYY-MM` buckets, oldest first — `groupBy`'s own ordering. */
  const MONTHS = "v.map((r) => r.when.slice(0, 7))"
    + ".filter((key, index, keys) => keys.indexOf(key) === index).sort()";

  const evaluated = (source: string, data: Record<string, Json>): Json | undefined => {
    const result = evaluateExpr(source, data);
    // An expression that could not run would compare equal to every wrapper
    // answer that is `undefined`, which is exactly how this seam went blind.
    if (!result.ok) throw new Error(`\`${source}\` did not evaluate: ${result.issue}`);
    return result.value;
  };

  const cases: Array<[string, Json | undefined, string, Record<string, Json>]> = [
    ["sum over numbers with a null", sum(rows, "amount"), SUM, { v: rows }],
    ["sum over no rows", sum(empty, "amount"), SUM, { v: empty }],
    ["count of rows", count(rows), "v.length", { v: rows }],
    ["count of no rows", count(empty), "v.length", { v: empty }],
    ["average over numbers with a null", average(rows, "amount"), `${SUM} / ${NUMERIC}.length`, { v: rows }],
    [
      "min over numbers with a null",
      min(rows, "amount"),
      `${NUMERIC}.reduce((low, r) => (r.amount < low ? r.amount : low), ${NUMERIC}[0].amount)`,
      { v: rows },
    ],
    [
      "max over numbers with a null",
      max(rows, "amount"),
      `${NUMERIC}.reduce((high, r) => (r.amount > high ? r.amount : high), ${NUMERIC}[0].amount)`,
      { v: rows },
    ],
    ["difference of two numbers", difference(10, 4), "a - b", { a: 10, b: 4 }],
    [
      "group_by month, summed",
      groupBy(rows, "when", "month", "sum", "amount"),
      `${MONTHS}.map((key) => ({ key, value: v.filter((r) => r.when.slice(0, 7) === key`
      + ' && typeof r.amount === "number").reduce((total, r) => total + r.amount, 0) }))',
      { v: rows },
    ],
    [
      "group_by month, counted",
      groupBy(rows, "when", "month", "count"),
      `${MONTHS}.map((key) => ({ key, value: v.filter((r) => r.when.slice(0, 7) === key).length }))`,
      { v: rows },
    ],
  ];

  for (const [name, wrapped, source, data] of cases) {
    it(`${name} — same answer as \`${source}\``, () => {
      expect(wrapped).toEqual(evaluated(source, data));
    });
  }
});

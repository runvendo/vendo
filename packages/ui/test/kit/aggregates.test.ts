import {
  type Json,
} from "@vendoai/core";
import {
  evaluateExpr,
} from "@vendoai/apps/contract";
import { describe, expect, it } from "vitest";
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

  it("answers empty rows the way the expression engine does", () => {
    expect(sum([], "amount_cents")).toBe(0);
    expect(count([])).toBe(0);
    expect(average([], "amount_cents")).toBeUndefined();
    expect(groupBy([], "issued_at", "month", "count")).toEqual([]);
  });
});

/**
 * THE SEAM (§0): there is exactly ONE aggregate implementation. Each wrapper is
 * asserted against `evaluateExpr` over the equivalent `.vendo` expression
 * source — the same call a `.vendo` screen's `$expr` takes. No stub on either
 * side. Break the shim's `sum` into its own reduce and this goes red.
 */
describe("the shim's aggregates ARE core's $expr, not a second implementation", () => {
  const rows: Json = [
    { amount: 10, when: "2026-03-01T00:00:00.000Z" },
    { amount: -4.5, when: "2026-03-09T00:00:00.000Z" },
    { amount: null, when: "2026-04-02T00:00:00.000Z" },
  ];
  const strings: Json = [{ amount: "10" }, { amount: "4" }];
  const missing: Json = [{ other: 1 }, { other: 2 }];
  const empty: Json = [];

  const expected = (source: string, data: Record<string, Json>): Json | undefined => {
    const result = evaluateExpr(source, data);
    return result.ok ? result.value : undefined;
  };

  const cases: Array<[string, Json | undefined, string, Record<string, Json>]> = [
    ["sum over numbers with a null", sum(rows, "amount"), 'sum(v, "amount")', { v: rows }],
    ["sum over strings", sum(strings, "amount"), 'sum(v, "amount")', { v: strings }],
    ["sum over rows missing the field", sum(missing, "amount"), 'sum(v, "amount")', { v: missing }],
    ["sum over no rows", sum(empty, "amount"), 'sum(v, "amount")', { v: empty }],
    ["count of rows", count(rows), "count(v)", { v: rows }],
    ["count of no rows", count(empty), "count(v)", { v: empty }],
    ["average over numbers with a null", average(rows, "amount"), 'average(v, "amount")', { v: rows }],
    ["average over no rows", average(empty, "amount"), 'average(v, "amount")', { v: empty }],
    ["min over numbers with a null", min(rows, "amount"), 'min(v, "amount")', { v: rows }],
    ["min over strings", min(strings, "amount"), 'min(v, "amount")', { v: strings }],
    ["max over numbers with a null", max(rows, "amount"), 'max(v, "amount")', { v: rows }],
    ["max over no rows", max(empty, "amount"), 'max(v, "amount")', { v: empty }],
    ["difference of two numbers", difference(10, 4), "difference(a, b)", { a: 10, b: 4 }],
    [
      "group_by month, summed",
      groupBy(rows, "when", "month", "sum", "amount"),
      'group_by(v, "when", "month", sum.of("amount"))',
      { v: rows },
    ],
    [
      "group_by month, counted",
      groupBy(rows, "when", "month", "count"),
      'group_by(v, "when", "month", count.of())',
      { v: rows },
    ],
  ];

  for (const [name, wrapped, source, data] of cases) {
    it(`${name} — same answer as \`${source}\``, () => {
      expect(wrapped).toEqual(expected(source, data));
    });
  }

  it("agrees with $expr on days_until at a fixed now", () => {
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    const direct = evaluateExpr("days_until(d)", { d: "2026-03-11T00:00:00.000Z" }, { now });
    expect(daysUntil("2026-03-11T00:00:00.000Z", { now })).toEqual(direct.ok ? direct.value : undefined);
  });
});

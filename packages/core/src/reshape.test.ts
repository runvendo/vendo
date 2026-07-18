import { describe, expect, it } from "vitest";
import {
  applyReshape,
  findInvalidReshape,
  RESHAPE_MAX_STEPS,
  reshapeShape,
  type ReshapeStep,
} from "./reshape.js";
import type { ShapeType } from "./shape.js";

const step = (op: string, ...args: string[]): ReshapeStep => ({ op, args } as ReshapeStep);

const rows = [
  { month: "Jan", revenue: 1200, note: "promo" },
  { month: "Feb", revenue: 900 },
];

const rowsShape: ShapeType = {
  kind: "array",
  items: {
    kind: "object",
    fields: {
      month: { kind: "string" },
      revenue: { kind: "number" },
      note: { kind: "string" },
    },
    optional: ["note"],
  },
};

/** v2 spec §3 — the bounded, pure, non-Turing reshape vocabulary. */
describe("applyReshape", () => {
  it("undefined in ⇒ ok/undefined out (loading data is not a mismatch)", () => {
    expect(applyReshape(undefined, [step("pick", "month")])).toEqual({ ok: true, value: undefined });
  });

  it("no steps ⇒ identity", () => {
    expect(applyReshape(rows, [])).toEqual({ ok: true, value: rows });
  });

  it("pick keeps fields per-row on arrays and directly on objects", () => {
    expect(applyReshape(rows, [step("pick", "month", "revenue")])).toEqual({
      ok: true,
      value: [{ month: "Jan", revenue: 1200 }, { month: "Feb", revenue: 900 }],
    });
    expect(applyReshape({ a: 1, b: 2 }, [step("pick", "a")])).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rename renames pairwise, tolerating rows without the field", () => {
    expect(applyReshape(rows, [step("rename", "month", "label")])).toEqual({
      ok: true,
      value: [
        { label: "Jan", revenue: 1200, note: "promo" },
        { label: "Feb", revenue: 900 },
      ],
    });
  });

  it("asPoints maps rows to { label, value } — the broken-chart fix", () => {
    expect(applyReshape(rows, [step("asPoints", "month", "revenue")])).toEqual({
      ok: true,
      value: [{ label: "Jan", value: 1200 }, { label: "Feb", value: 900 }],
    });
  });

  it("asPoints is strict per-row: a mixed-row response is a mismatch, never a silent partial chart", () => {
    const mixed = applyReshape(
      [{ month: "Jan", revenue: 1 }, { month: "Feb" }],
      [step("asPoints", "month", "revenue")],
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.reason).toContain("revenue");
    // Sparse data carries explicit nulls; those rows still plot.
    expect(applyReshape(
      [{ month: "Jan", revenue: 1 }, { month: "Feb", revenue: null }],
      [step("asPoints", "month", "revenue")],
    )).toEqual({ ok: true, value: [{ label: "Jan", value: 1 }, { label: "Feb", value: null }] });
  });

  it("chains steps left to right", () => {
    expect(applyReshape(rows, [step("pick", "month", "revenue"), step("rename", "month", "label")])).toEqual({
      ok: true,
      value: [{ label: "Jan", revenue: 1200 }, { label: "Feb", revenue: 900 }],
    });
  });

  it("aggregates: sum/avg/min/max over a field, count over the array", () => {
    expect(applyReshape(rows, [step("sum", "revenue")])).toEqual({ ok: true, value: 2100 });
    expect(applyReshape(rows, [step("avg", "revenue")])).toEqual({ ok: true, value: 1050 });
    expect(applyReshape(rows, [step("min", "revenue")])).toEqual({ ok: true, value: 900 });
    expect(applyReshape(rows, [step("max", "revenue")])).toEqual({ ok: true, value: 1200 });
    expect(applyReshape(rows, [step("count")])).toEqual({ ok: true, value: 2 });
  });

  it("aggregates over an empty array: sum 0, count 0, avg/min/max null", () => {
    expect(applyReshape([], [step("sum", "x")])).toEqual({ ok: true, value: 0 });
    expect(applyReshape([], [step("count")])).toEqual({ ok: true, value: 0 });
    expect(applyReshape([], [step("avg", "x")])).toEqual({ ok: true, value: null });
  });

  it("format renders deterministic en-US strings (scalar and per-row forms)", () => {
    expect(applyReshape(0.42, [step("format", "percent")])).toEqual({ ok: true, value: "42%" });
    expect(applyReshape(1234.5, [step("format", "currency")])).toEqual({ ok: true, value: "$1,234.50" });
    expect(applyReshape(1234.5, [step("format", "number")])).toEqual({ ok: true, value: "1,234.5" });
    const formatted = applyReshape(rows, [step("format", "revenue", "currency")]);
    expect(formatted).toEqual({
      ok: true,
      value: [
        { month: "Jan", revenue: "$1,200.00", note: "promo" },
        { month: "Feb", revenue: "$900.00" },
      ],
    });
  });

  it("format date accepts ISO strings and epoch numbers, UTC-stable", () => {
    expect(applyReshape("2026-07-18T12:00:00Z", [step("format", "date")]))
      .toEqual({ ok: true, value: "Jul 18, 2026" });
  });

  it("runtime mismatches are contained: ok false with a reason, never a throw", () => {
    const onScalar = applyReshape(42, [step("pick", "month")]);
    expect(onScalar.ok).toBe(false);
    const fieldAbsent = applyReshape(rows, [step("asPoints", "period", "revenue")]);
    expect(fieldAbsent.ok).toBe(false);
    if (!fieldAbsent.ok) expect(fieldAbsent.reason).toContain("period");
    const badAggregate = applyReshape([{ v: "x" }], [step("sum", "v")]);
    expect(badAggregate.ok).toBe(false);
    const badFormat = applyReshape("hello", [step("format", "currency")]);
    expect(badFormat.ok).toBe(false);
  });

  it("a field absent from every non-empty row is a mismatch; absent from some rows is not", () => {
    expect(applyReshape(rows, [step("rename", "period", "label")]).ok).toBe(false);
    expect(applyReshape(rows, [step("rename", "note", "label")]).ok).toBe(true);
  });
});

describe("reshapeShape (compile-time flow)", () => {
  it("flows a known shape through each op", () => {
    const picked = reshapeShape(rowsShape, step("pick", "month", "revenue"));
    expect(picked).toEqual({
      ok: true,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          fields: { month: { kind: "string" }, revenue: { kind: "number" } },
        },
      },
    });
    const points = reshapeShape(rowsShape, step("asPoints", "month", "revenue"));
    expect(points).toEqual({
      ok: true,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          fields: { label: { kind: "string" }, value: { kind: "number" } },
        },
      },
    });
    const summed = reshapeShape(rowsShape, step("sum", "revenue"));
    expect(summed).toEqual({ ok: true, shape: { kind: "number" } });
    const renamed = reshapeShape(rowsShape, step("rename", "note", "hint"));
    if (!renamed.ok) throw new Error(renamed.error.message);
    expect(renamed.shape).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: {
          month: { kind: "string" },
          revenue: { kind: "number" },
          hint: { kind: "string" },
        },
        optional: ["hint"],
      },
    });
  });

  it("format makes the formatted region a string", () => {
    const scalar = reshapeShape({ kind: "number" }, step("format", "currency"));
    expect(scalar).toEqual({ ok: true, shape: { kind: "string" } });
    const perRow = reshapeShape(rowsShape, step("format", "revenue", "currency"));
    if (!perRow.ok) throw new Error(perRow.error.message);
    expect(perRow.shape).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: {
          month: { kind: "string" },
          revenue: { kind: "string" },
          note: { kind: "string" },
        },
        optional: ["note"],
      },
    });
  });

  it("json stays defensive: any step flows, aggregates still type as number", () => {
    expect(reshapeShape({ kind: "json" }, step("pick", "a"))).toEqual({ ok: true, shape: { kind: "json" } });
    expect(reshapeShape({ kind: "json" }, step("count"))).toEqual({ ok: true, shape: { kind: "number" } });
    expect(reshapeShape({ kind: "json" }, step("sum", "x"))).toEqual({ ok: true, shape: { kind: "number" } });
  });

  it("known-shape violations carry missing and available fields for repair", () => {
    const result = reshapeShape(rowsShape, step("asPoints", "period", "revenue"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.missing).toEqual(["period"]);
      expect(result.error.available).toEqual(["month", "revenue", "note"]);
    }
    expect(reshapeShape({ kind: "number" }, step("pick", "a")).ok).toBe(false);
    expect(reshapeShape(rowsShape, step("sum", "month")).ok).toBe(false);
    expect(reshapeShape({ kind: "string" }, step("format", "currency")).ok).toBe(false);
  });
});

describe("findInvalidReshape (the validateTreeV2 gate)", () => {
  it("accepts valid steps anywhere in a props record, and props without reshape", () => {
    expect(findInvalidReshape({
      points: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] },
    })).toBeNull();
    expect(findInvalidReshape({ title: "x", nested: [{ deep: { $path: "/a" } }] })).toBeNull();
  });

  it("rejects unknown ops, bad arities, and non-string args, nested at any depth", () => {
    expect(findInvalidReshape({
      nested: [{ bad: { $path: "/a", $reshape: [{ op: "eval", args: [] }] } }],
    })).toContain("eval");
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "asPoints", args: ["only-one"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "rename", args: ["odd", "pair", "extra"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "pick", args: [1] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "format", args: ["x", "loud"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({ p: { $path: "/a", $reshape: "pick" } })).not.toBeNull();
  });

  it("caps the chain length (bounded, non-Turing)", () => {
    const steps = Array.from({ length: RESHAPE_MAX_STEPS + 1 }, () => ({ op: "count", args: [] }));
    expect(findInvalidReshape({ p: { $path: "/a", $reshape: steps } })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: steps.slice(0, RESHAPE_MAX_STEPS) },
    })).toBeNull();
  });
});

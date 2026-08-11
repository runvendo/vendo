import { applyReshape } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { reshape } from "../../src/kit/reshape.js";

const rows = [
  { month: "2026-01", revenue: 100, cost: 40 },
  { month: "2026-02", revenue: 250, cost: 60 },
];

describe("the eight reshape wrappers", () => {
  it("covers exactly the eight LIVE ops — the deprecated ones and retired avg are not wrapped", () => {
    // avg retired with the pipe (#808); code-land averages through the `average`
    // aggregate (aggregates.test.ts), not a reshape op.
    expect(Object.keys(reshape).sort()).toEqual(
      ["asPoints", "count", "format", "max", "min", "pick", "rename", "sum"],
    );
  });

  it("projects like the op it wraps", () => {
    expect(reshape.pick(rows, "month", "revenue")).toEqual([
      { month: "2026-01", revenue: 100 },
      { month: "2026-02", revenue: 250 },
    ]);
    expect(reshape.rename(rows, "revenue", "value")).toEqual([
      { month: "2026-01", value: 100, cost: 40 },
      { month: "2026-02", value: 250, cost: 60 },
    ]);
    expect(reshape.asPoints(rows, "month", "revenue")).toEqual([
      { label: "2026-01", value: 100 },
      { label: "2026-02", value: 250 },
    ]);
    expect(reshape.format(1234.56, "money")).toBe("$1,234.56");
    expect(reshape.format(0.42, "percent")).toBe("42%");
    expect(reshape.sum(rows, "revenue")).toBe(350);
    expect(reshape.min(rows, "revenue")).toBe(100);
    expect(reshape.max(rows, "revenue")).toBe(250);
    expect(reshape.count(rows)).toBe(2);
  });

  it("is the SAME answer applyReshape gives — one implementation, wrapped", () => {
    const cases: Array<[unknown, { op: string; args: string[] }]> = [
      [reshape.pick(rows, "month"), { op: "pick", args: ["month"] }],
      [reshape.rename(rows, "revenue", "value"), { op: "rename", args: ["revenue", "value"] }],
      [reshape.asPoints(rows, "month", "cost"), { op: "asPoints", args: ["month", "cost"] }],
      // `format` is absent: it takes a single value, so it has no answer to
      // give over rows — the case below pins that refusal in both venues.
      [reshape.sum(rows, "cost"), { op: "sum", args: ["cost"] }],
      [reshape.min(rows, "cost"), { op: "min", args: ["cost"] }],
      [reshape.max(rows, "cost"), { op: "max", args: ["cost"] }],
      [reshape.count(rows), { op: "count", args: [] }],
    ];
    for (const [wrapped, step] of cases) {
      const direct = applyReshape(rows, [step as never]);
      expect(wrapped).toEqual(direct.ok ? direct.value : undefined);
    }
  });

  it("passes loading through: undefined in, undefined out — never a mismatch", () => {
    expect(reshape.pick(undefined, "month")).toBeUndefined();
    expect(reshape.sum(undefined, "revenue")).toBeUndefined();
    expect(reshape.count(undefined)).toBeUndefined();
  });

  it("degrades to undefined on a mismatch instead of throwing", () => {
    expect(reshape.pick(rows, "nope")).toBeUndefined();
    expect(reshape.sum(rows, "month")).toBeUndefined();
    expect(reshape.count(42)).toBeUndefined();
    expect(reshape.asPoints("not rows", "a", "b")).toBeUndefined();
    // an arg the closed vocabulary rejects is a mismatch, not an exception
    expect(reshape.format(1234.56, "klingon")).toBeUndefined();
  });

  it("has no row form — a table column formats through its own token", () => {
    // The wrapper's one posture turns core's refusal into undefined; the REASON
    // is there for an app that asks, and it names the replacement.
    expect(reshape.format(rows, "money")).toBeUndefined();
    const direct = applyReshape(rows, [{ op: "format", args: ["money"] }]);
    expect(direct.ok ? "" : direct.reason).toContain('columns={[{key:"amount", format:"money"}]}');
  });

  it("reads the reason through applyReshape when the app wants one", () => {
    const result = applyReshape(rows, [{ op: "sum", args: ["month"] }]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("numeric");
  });

  it("has no answer (undefined) for min/max over no rows", () => {
    expect(reshape.min([], "revenue")).toBeUndefined();
    expect(reshape.max([], "revenue")).toBeUndefined();
    expect(reshape.sum([], "revenue")).toBe(0);
    expect(reshape.count([])).toBe(0);
  });
});

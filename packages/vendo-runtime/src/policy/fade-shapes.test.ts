import { describe, expect, it } from "vitest";
import { deriveFadeShape, shapeKey, grantScopeFromShape, computeProposalId } from "./fade-shapes.js";

describe("deriveFadeShape", () => {
  it("first email-shaped string field -> matches on its domain", () => {
    expect(deriveFadeShape({ to: "jim@acme.co", subject: "hi" }))
      .toEqual({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
  });
  it("prefers the FIRST email field over a later one", () => {
    expect(deriveFadeShape({ cc: "b@x.co", to: "a@acme.co" }).path).toBe("cc");
  });
  it("falls back to a type/kind/status/category string field", () => {
    expect(deriveFadeShape({ amount: 100, type: "invoice" }))
      .toEqual({ kind: "constrained", path: "type", op: "eq", value: "invoice" });
  });
  it("falls back to tool-wide when nothing matches", () => {
    expect(deriveFadeShape({ amount: 100 })).toEqual({ kind: "tool" });
  });
  it("falls back to tool-wide for non-object input", () => {
    expect(deriveFadeShape("raw string")).toEqual({ kind: "tool" });
    expect(deriveFadeShape(null)).toEqual({ kind: "tool" });
    expect(deriveFadeShape(["a@b.co"])).toEqual({ kind: "tool" });
  });
});

describe("shapeKey", () => {
  it("is stable and shape-distinguishing", () => {
    const a = deriveFadeShape({ to: "a@acme.co" });
    const b = deriveFadeShape({ to: "b@acme.co" });
    expect(shapeKey(a)).toBe(shapeKey(b)); // same domain -> same shape
    expect(shapeKey({ kind: "tool" })).toBe("tool");
  });
});

describe("grantScopeFromShape", () => {
  it("tool shape -> tool scope", () => {
    expect(grantScopeFromShape({ kind: "tool" })).toEqual({ kind: "tool" });
  });
  it("constrained shape -> a ONE-constraint constrained scope (never wider)", () => {
    const shape = deriveFadeShape({ to: "a@acme.co" });
    expect(grantScopeFromShape(shape)).toEqual({
      kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
    });
  });
});

describe("computeProposalId", () => {
  it("is deterministic for the same principal+tool+shape", () => {
    const p = { tenantId: "t", subject: "u" };
    const shape = deriveFadeShape({ to: "a@acme.co" });
    expect(computeProposalId(p, "send_email", shape)).toBe(computeProposalId(p, "send_email", shape));
  });
  it("differs across tools/principals/shapes", () => {
    const p = { tenantId: "t", subject: "u" };
    const shape = deriveFadeShape({ to: "a@acme.co" });
    const other = deriveFadeShape({ to: "a@other.co" });
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId(p, "other_tool", shape));
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId({ ...p, subject: "u2" }, "send_email", shape));
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId(p, "send_email", other));
  });
});

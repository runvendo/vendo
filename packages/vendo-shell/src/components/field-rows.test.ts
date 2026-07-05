import { describe, expect, it } from "vitest";
import { approvalRows, fieldValue } from "./field-rows";

describe("fieldValue", () => {
  it("renders object values as compact Key: value lines, not raw JSON (live-verification polish 2026-07-04)", () => {
    expect(fieldValue({ action: "reject", reason: "Wrong file" }, 160)).toBe(
      "Action: reject\nReason: Wrong file",
    );
    // The host-API `{body: {body: "…"}}` shape that showed as raw JSON live.
    expect(fieldValue({ body: "Hi Marisol" }, 160)).toBe("Body: Hi Marisol");
  });

  it("caps compact rendering at depth 1 — deeper values fall back to JSON", () => {
    expect(fieldValue({ outer: { inner: 1 } }, 160)).toBe('Outer: {"inner":1}');
  });

  it("renders arrays one item per line", () => {
    expect(fieldValue(["a@x.com", "b@x.com"], 160)).toBe("a@x.com\nb@x.com");
  });

  it("truncates per line, and never with maxChars null (critical cards)", () => {
    const long = "x".repeat(200);
    expect(fieldValue({ note: long }, 20)).toBe(`Note: ${"x".repeat(20)}…`);
    expect(fieldValue({ note: long }, null)).toBe(`Note: ${long}`);
  });

  it("skips empty entries inside an object value", () => {
    expect(fieldValue({ a: "1", b: "", c: [] }, 160)).toBe("A: 1");
  });
});

describe("approvalRows", () => {
  it("keeps flat values as before and applies compact rendering to nested ones", () => {
    const { rows } = approvalRows({ id: "cl_rivera", body: { body: "Hi" } }, 160);
    expect(rows).toEqual([
      { label: "Id", value: "cl_rivera" },
      { label: "Body", value: "Body: Hi" },
    ]);
  });

  it("caps an act-tier (maxChars: number) card at MAX_ROWS with a +more count", () => {
    const input = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, `v${i}`]));
    const { rows, more } = approvalRows(input, 160);
    expect(rows).toHaveLength(8);
    expect(more).toBe(4);
  });

  it("a critical card (maxChars: null) also lifts the ROW cap — all 12 fields render, not just 8 (finding 2)", () => {
    const input = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, `v${i}`]));
    const { rows, more } = approvalRows(input, null);
    expect(rows).toHaveLength(12);
    expect(more).toBe(0);
  });
});

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

  it("formats a `cents`-hinted field as currency — the critical-card money bug (raw 50000 → $500.00)", () => {
    const { rows } = approvalRows(
      { recipient_name: "Alex Rivera", amount: 50000, memo: "June rent" },
      null,
      { amount: "cents" },
    );
    expect(rows).toEqual([
      { label: "Recipient name", value: "Alex Rivera" },
      { label: "Amount", value: "$500.00" },
      { label: "Memo", value: "June rent" },
    ]);
  });

  it("leaves an un-hinted number untouched — never guesses a divisor", () => {
    const { rows } = approvalRows({ amount: 50000 }, null);
    expect(rows).toEqual([{ label: "Amount", value: "50000" }]);
  });

  it("adds thousands separators for large cents amounts", () => {
    const { rows } = approvalRows({ amount: 1234567 }, null, { amount: "cents" });
    expect(rows[0]).toEqual({ label: "Amount", value: "$12,345.67" });
  });

  it("renders negative cents with the sign outside the symbol", () => {
    const { rows } = approvalRows({ amount: -5000 }, null, { amount: "cents" });
    expect(rows[0]).toEqual({ label: "Amount", value: "-$50.00" });
  });

  it("never applies a cents hint to a non-number value (no guessing) — falls back to humanization", () => {
    const { rows } = approvalRows({ amount: "50000" }, null, { amount: "cents" });
    expect(rows[0]).toEqual({ label: "Amount", value: "50000" });
  });

  it("renders a `percent`-hinted number with a % sign, as-is (never rescaled)", () => {
    const { rows } = approvalRows({ rate: 12.5 }, null, { rate: "percent" });
    expect(rows[0]).toEqual({ label: "Rate", value: "12.5%" });
  });

  it("renders an `iso-date`-hinted string as a localized day without a timezone shift", () => {
    const { rows } = approvalRows({ due: "2026-07-01" }, null, { due: "iso-date" });
    expect(rows[0]).toEqual({ label: "Due", value: "Jul 1, 2026" });
  });
});

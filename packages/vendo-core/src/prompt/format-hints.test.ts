import { describe, expect, it } from "vitest";
import { renderFormatHints } from "./format-hints.js";

describe("renderFormatHints", () => {
  it("returns empty for an empty map", () => {
    expect(renderFormatHints({})).toBe("");
  });

  it("cents fields teach the exact divisor and forbid guessing", () => {
    const s = renderFormatHints({ amount: "cents" });
    expect(s).toContain('"amount"');
    expect(s).toMatch(/integer cents/i);
    expect(s).toMatch(/divide by (exactly )?100/i);
    // The 100x-wrong stat tile: totals must use the same divisor as the rows.
    expect(s).toMatch(/total|sum/i);
  });

  it("iso-date fields are literal calendar dates, never timezone-shifted", () => {
    const s = renderFormatHints({ dueDate: "iso-date" });
    expect(s).toContain('"dueDate"');
    expect(s).toMatch(/calendar date/i);
    expect(s).toMatch(/never/i);
    expect(s).toMatch(/timezone/i);
  });

  it("iso-datetime fields render in the viewer's local time, not the UTC string's date", () => {
    const s = renderFormatHints({ filingDeadline: "iso-datetime" });
    expect(s).toContain('"filingDeadline"');
    expect(s).toMatch(/local/i);
    expect(s).toMatch(/one day|day off/i);
  });

  it("percent fields are already scaled — no re-scaling", () => {
    const s = renderFormatHints({ apy: "percent" });
    expect(s).toContain('"apy"');
    expect(s).toMatch(/never multiply|do not multiply/i);
  });

  it("renders one line per field under a single header", () => {
    const s = renderFormatHints({ amount: "cents", timestamp: "iso-datetime" });
    expect(s).toMatch(/RESULT FIELD FORMATS/);
    expect(s.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });
});

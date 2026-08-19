import { describe, expect, it } from "vitest";
import {
  applyFormat,
  formatDateTime,
  formatMoney,
  formatNum,
  isRenderableNumber,
} from "../../src/kit/format.js";

describe("applyFormat text tier", () => {
  it("treats an empty/whitespace string as unrenderable — components show the placeholder, never a bare label", () => {
    expect(applyFormat("", "text")).toBeNull();
    expect(applyFormat("   ", "text")).toBeNull();
    expect(applyFormat(null, "text")).toBeNull();
    expect(applyFormat(undefined, "text")).toBeNull();
  });

  it("passes real text (and stringy falsish values) through", () => {
    expect(applyFormat("First Bank", "text")).toBe("First Bank");
    expect(applyFormat(0, "text")).toBe("0");
    expect(applyFormat(false, "text")).toBe("false");
  });
});

describe("formatMoney (takes major units)", () => {
  it("pretty-prints an amount that is already dollars", () => {
    expect(formatMoney(1234.56)).toBe("$1,234.56");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-5)).toBe("-$5.00");
  });

  it("never converts units — a raw cents value formats 100x, which is the caller's bug", () => {
    // The contract: formatters pretty-print, callers divide. A cents field is
    // `/100` in the expression that reads it, never here.
    expect(formatMoney(123456)).toBe("$123,456.00");
  });

  it("honors currency + locale, and the ISO minor unit sets the decimals shown", () => {
    expect(formatMoney(1000, { currency: "EUR", locale: "de-DE" })).toContain("1.000,00");
    // JPY has 0 minor digits, so whole yen show no decimals.
    expect(formatMoney(100000, { currency: "JPY" })).toBe("¥100,000");
  });

  it("never renders $NaN — invalid input returns null", () => {
    expect(formatMoney(Number.NaN)).toBeNull();
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBeNull();
    // deliberately exercising the runtime guard against bad model data
    expect(formatMoney(undefined as unknown as number)).toBeNull();
    expect(formatMoney("1234" as unknown as number)).toBeNull();
  });
});

describe("formatNum", () => {
  it("groups thousands", () => {
    expect(formatNum(1234567)).toBe("1,234,567");
    expect(formatNum(1234.567, { maximumFractionDigits: 2 })).toBe("1,234.57");
  });

  it("supports compact notation", () => {
    expect(formatNum(1500000, { notation: "compact" })).toBe("1.5M");
  });

  it("writes a unit after the figure, so a bare number never has to carry one", () => {
    expect(formatNum(842, { unit: "ms" })).toBe("842 ms");
    expect(formatNum(9.5, { unit: "h" })).toBe("9.5 h");
    expect(formatNum(1500000, { notation: "compact", unit: "GB" })).toBe("1.5M GB");
  });

  it("returns null for non-finite input", () => {
    expect(formatNum(Number.NaN)).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("formats an ISO string as a date", () => {
    expect(formatDateTime("2026-03-14", { mode: "date" })).toBe("Mar 14, 2026");
  });

  it("formats epoch millis and Date instances", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 0, 0, 0));
    expect(formatDateTime(d, { mode: "date", timeZone: "UTC" })).toBe("Jan 2, 2026");
  });

  it("compact drops the YEAR and keeps the clock", () => {
    expect(formatDateTime("2026-08-12", { mode: "date" })).toBe("Aug 12, 2026");
    expect(formatDateTime("2026-08-12", { mode: "date", compact: true })).toBe("Aug 12");
    const stamp = formatDateTime(Date.UTC(2026, 7, 12, 15, 30), {
      mode: "datetime",
      compact: true,
      timeZone: "UTC",
    });
    expect(stamp).toContain("Aug 12");
    expect(stamp).toMatch(/3:30/);
    expect(stamp).not.toContain("2026");
  });

  it("shows no clock for a date-only value asked for as a datetime", () => {
    // A `due_date` used to render "Aug 1, 2026, 12:00 AM" — a time nobody stored.
    expect(formatDateTime("2026-08-01", { mode: "datetime" })).toBe("Aug 1, 2026");
    // A value that HAS a clock still keeps it.
    expect(formatDateTime("2026-08-01T15:30:00Z", { mode: "datetime", timeZone: "UTC" })).toMatch(/3:30/);
  });

  it("returns null for unparseable input (never Invalid Date)", () => {
    expect(formatDateTime("not-a-date")).toBeNull();
    expect(formatDateTime(Number.NaN)).toBeNull();
    expect(formatDateTime(undefined as unknown as string)).toBeNull();
  });

  it("refuses a string that names less than a full day, rather than guessing the rest", () => {
    // V8's fallback parser answers a yearless stamp with 2001 — "Aug 15, 7:42 AM"
    // became August 15th 2001, and "Week 1" became New Year's Day. Text already
    // written for a reader is not data to re-read; the caller shows it as it is.
    for (const written of ["Aug 15, 7:42 AM", "Aug 15", "Week 1", "15 Aug", "2026-08"]) {
      expect(formatDateTime(written, { mode: "datetime" }), written).toBeNull();
    }
    // A full ISO day, with or without a clock, is still parsed.
    expect(formatDateTime("2026-08-15", { mode: "date" })).toBe("Aug 15, 2026");
    expect(formatDateTime("2026-08-15 07:42:00Z", { mode: "datetime", timeZone: "UTC" })).toMatch(/7:42/);
  });
});

describe("isRenderableNumber", () => {
  it("accepts only finite numbers", () => {
    expect(isRenderableNumber(0)).toBe(true);
    expect(isRenderableNumber(-3.2)).toBe(true);
    expect(isRenderableNumber(Number.NaN)).toBe(false);
    expect(isRenderableNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRenderableNumber("5")).toBe(false);
    expect(isRenderableNumber(null)).toBe(false);
  });
});

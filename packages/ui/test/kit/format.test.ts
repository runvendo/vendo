import { describe, expect, it } from "vitest";
import {
  applyFormat,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatNum,
  formatPercent,
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

describe("formatPercent (takes a ratio 0..1 by default)", () => {
  it("renders a ratio as a percentage", () => {
    expect(formatPercent(0.42)).toBe("42%");
    expect(formatPercent(0.1234, { fractionDigits: 1 })).toBe("12.3%");
  });

  it("can take an already-whole percentage", () => {
    expect(formatPercent(42, { whole: true })).toBe("42%");
  });

  it("returns null for non-finite input", () => {
    expect(formatPercent(Number.NaN)).toBeNull();
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

describe("formatDuration (takes seconds)", () => {
  it("reads a count of seconds as a duration", () => {
    expect(formatDuration(268)).toBe("4m 28s");
    expect(formatDuration(412)).toBe("6m 52s");
    // A minutes field is `* 60` where it is read, the way cents are `/ 100`.
    expect(formatDuration(158 * 60)).toBe("2h 38m");
  });

  it("keeps to the two largest units — a duration is one figure, not three", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(90 * 60)).toBe("1h 30m");
    expect(formatDuration(5 * 86_400)).toBe("5d");
  });

  it("drops a unit that would read as zero", () => {
    expect(formatDuration(46)).toBe("46s");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(3600)).toBe("1h");
  });

  it("says 0s rather than nothing at all, and keeps a sign", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0.4)).toBe("0s");
    expect(formatDuration(-115 * 60)).toBe("-1h 55m");
  });

  it("returns null for non-finite input", () => {
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull();
    // deliberately exercising the runtime guard against bad model data
    expect(formatDuration("268" as unknown as number)).toBeNull();
  });

  it("is reachable through the format token every column and Stat takes", () => {
    expect(applyFormat(268, "duration")).toBe("4m 28s");
    expect(applyFormat("268", "duration")).toBeNull();
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

import { describe, expect, it } from "vitest";
import {
  applyFormat,
  formatDateTime,
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

describe("formatMoney (takes integer cents)", () => {
  it("formats cents as currency, dividing by 100", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-500)).toBe("-$5.00");
  });

  it("honors currency + locale", () => {
    expect(formatMoney(100000, { currency: "EUR", locale: "de-DE" })).toContain("1.000,00");
    // JPY has 0 minor digits, so the integer IS whole yen (no ÷100).
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

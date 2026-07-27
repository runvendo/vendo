import { describe, expect, it } from "vitest";
import { deriveVerifyBand, inVerifyBand } from "./band.js";

describe("deriveVerifyBand (K14 T1)", () => {
  it("spans the overlap: min(answerable) to max(unanswerable)", () => {
    expect(deriveVerifyBand({ answerable: [0.7, 0.9, 0.8], unanswerable: [0.5, 0.75, 0.6] })).toEqual({
      low: 0.7,
      high: 0.75,
    });
  });

  it("rounds outward to four decimals so the band never narrows on rounding", () => {
    // low 0.67352… floors to 0.6735 (wider), high 0.78344… ceils to 0.7835.
    expect(deriveVerifyBand({ answerable: [0.673526225], unanswerable: [0.7834431] })).toEqual({
      low: 0.6735,
      high: 0.7835,
    });
  });

  it("returns undefined when the populations separate — a plain threshold is right there", () => {
    expect(deriveVerifyBand({ answerable: [0.8, 0.9], unanswerable: [0.5, 0.6] })).toBeUndefined();
  });

  it("returns undefined when the populations only touch (max unanswerable == min answerable)", () => {
    expect(deriveVerifyBand({ answerable: [0.7, 0.8], unanswerable: [0.6, 0.7] })).toBeUndefined();
  });

  it("returns undefined when either population is empty", () => {
    expect(deriveVerifyBand({ answerable: [], unanswerable: [0.5] })).toBeUndefined();
    expect(deriveVerifyBand({ answerable: [0.5], unanswerable: [] })).toBeUndefined();
  });
});

describe("inVerifyBand", () => {
  const band = { low: 0.6735, high: 0.7835 };

  it("is inclusive at both edges", () => {
    expect(inVerifyBand(0.6735, band)).toBe(true);
    expect(inVerifyBand(0.7835, band)).toBe(true);
  });

  it("excludes scores outside the band", () => {
    expect(inVerifyBand(0.6734, band)).toBe(false);
    expect(inVerifyBand(0.7836, band)).toBe(false);
  });
});

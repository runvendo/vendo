import { describe, expect, it } from "vitest";
import { resolveCenterValue } from "./center-value.js";

const slice = (label: string, value: number, display?: string) => ({ label, value, display });

describe("resolveCenterValue", () => {
  it("overrides a wrongly re-divided money center with the sum of the legend", () => {
    // The real bug: legend sums to $4,017.81, model wrote "$40.18" (÷100 twice).
    const slices = [
      slice("Groceries", 2850, "$2,850.00"),
      slice("Rent", 441.4, "$441.40"),
      slice("Subscriptions", 296.99, "$296.99"),
      slice("Shopping", 200.04, "$200.04"),
      slice("Transport", 177.2, "$177.20"),
      slice("Coffee", 52.18, "$52.18"),
    ];
    expect(resolveCenterValue(slices, "$40.18")).toBe("$4,017.81");
  });

  it("derives the center when the model omits it entirely", () => {
    const slices = [slice("A", 10, "$10.00"), slice("B", 5, "$5.00")];
    expect(resolveCenterValue(slices, undefined)).toBe("$15.00");
  });

  it("matches the legend's decimal precision (whole-dollar displays stay whole)", () => {
    const slices = [slice("A", 2850, "$2,850"), slice("B", 1150, "$1,150")];
    expect(resolveCenterValue(slices, "$40")).toBe("$4,000");
  });

  it("leaves a non-currency center (a percentage) untouched", () => {
    const slices = [slice("Done", 62, "$62"), slice("Left", 38, "$38")];
    expect(resolveCenterValue(slices, "62%")).toBe("62%");
  });

  it("keeps the model value when slices carry no display strings", () => {
    const slices = [slice("A", 10), slice("B", 5)];
    expect(resolveCenterValue(slices, "$15")).toBe("$15");
  });

  it("keeps the model value when currency symbols are inconsistent", () => {
    const slices = [slice("A", 10, "$10"), slice("B", 5, "£5")];
    expect(resolveCenterValue(slices, "$15")).toBe("$15");
  });

  it("respects a non-dollar currency symbol", () => {
    const slices = [slice("A", 10, "£10.00"), slice("B", 5, "£5.00")];
    expect(resolveCenterValue(slices, "£1.50")).toBe("£15.00");
  });
});

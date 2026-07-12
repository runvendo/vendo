import { describe, expect, it } from "vitest";
import { measure, percentile, summarize } from "./stats.js";

describe("percentile", () => {
  it("returns 0 for an empty sample", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("returns the sole value for a one-element sample", () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("computes p50 as the median (R-7 / linear interpolation)", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
  });

  it("interpolates p95 between neighbours", () => {
    // 10 samples 1..10: rank = 9 * 0.95 = 8.55 → 9 + (10-9)*0.55 = 9.55
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 5);
  });

  it("is order-independent", () => {
    const shuffled = [5, 1, 4, 2, 3];
    expect(percentile(shuffled, 0.5)).toBe(3);
  });
});

describe("summarize", () => {
  it("produces p50/p95/min/max rounded to microseconds", () => {
    const result = summarize("x", [1, 2, 3, 4, 5]);
    expect(result).toMatchObject({ name: "x", unit: "ms", samples: 5, min: 1, max: 5, p50: 3 });
    expect(result.p95).toBeCloseTo(4.8, 5);
  });
});

describe("measure", () => {
  it("runs exactly `iterations` measured passes after warmup", async () => {
    let calls = 0;
    const durations = await measure({ warmup: 3, iterations: 5, fn: () => { calls += 1; } });
    expect(calls).toBe(8);
    expect(durations).toHaveLength(5);
    for (const d of durations) expect(d).toBeGreaterThanOrEqual(0);
  });
});

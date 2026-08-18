// @vitest-environment jsdom
/**
 * A NEGATIVE BAR.
 *
 * A bar chart is the one chart that can hold a loss — a refund, a drawdown, a
 * month that went the other way — and recharts says so by handing the rectangle a
 * NEGATIVE `height` (going up) or `width` (going right), then passing both straight
 * onto the SVG element. A saved case shipped `width="-18.125"`, which is not a legal
 * attribute value, and the loss painted in the same colour as every gain beside it:
 * the one figure on the chart a reader must not have to trace back to an axis was
 * the one figure nothing marked.
 *
 * So this pins both halves at once, on the real chart rather than on the shape in
 * isolation: what the element CARRIES (a magnitude, never a negative) and what it
 * PAINTS (the host's own danger tone).
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart } from "../../src/kit/charts/bar.js";
import { toneColor } from "../../src/kit/tokens.js";

/**
 * jsdom lays nothing out, so recharts' ResponsiveContainer measures zero and draws
 * no SVG at all. State the size its observer reports and the real chart renders.
 * (The same stub charts.test.tsx uses — kept local because it is the whole reason
 * either file can read a rendered bar.)
 */
function stubChartSize(width: number, height: number): () => void {
  const real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;
  return () => {
    globalThis.ResizeObserver = real;
  };
}

/** One month down between two up — a real chart's shape, not a chart of losses. */
const MONTHS = [
  { month: "Jan", net: 120 },
  { month: "Feb", net: -40 },
  { month: "Mar", net: 80 },
];

/** Every bar the chart drew, as the browser would read it. */
const bars = (container: HTMLElement) =>
  [...container.querySelectorAll(".recharts-bar-rectangle path")].map((bar) => ({
    width: Number(bar.getAttribute("width")),
    height: Number(bar.getAttribute("height")),
    fill: bar.getAttribute("fill") ?? "",
  }));

const drawn = (props: Parameters<typeof BarChart>[0]) => {
  const restore = stubChartSize(360, 220);
  try {
    return bars(render(<BarChart {...props} />).container);
  } finally {
    restore();
  }
};

describe("a bar that hangs the other way", () => {
  it("paints the loss in the host's danger tone, and every gain in the series colour", () => {
    const [jan, feb, mar] = drawn({ data: MONTHS, xKey: "month", series: ["net"] });

    // The Kit's own bad-news tone, resolved the one way every other toned brick
    // resolves it — so it is the HOST's danger on any brand, never a red the chart
    // invented.
    expect(feb!.fill).toBe(toneColor("danger"));
    expect(jan!.fill).toContain("var(--vendo-chart-1");
    expect(mar!.fill).toBe(jan!.fill);
  });

  it("carries a MAGNITUDE, so no bar ever states a negative width or height", () => {
    for (const bar of drawn({ data: MONTHS, xKey: "month", series: ["net"] })) {
      expect(bar.height).toBeGreaterThan(0);
      expect(bar.width).toBeGreaterThan(0);
    }
    // …and the same going right, which is the layout the saved `width="-18.125"`
    // came from.
    for (const bar of drawn({ data: MONTHS, xKey: "month", series: ["net"], horizontal: true })) {
      expect(bar.width).toBeGreaterThan(0);
      expect(bar.height).toBeGreaterThan(0);
    }
  });

  it("leaves a chart with nothing to lose exactly as it was", () => {
    // The treatment is the loss's, not the chart's: a series that never goes below
    // the baseline must be untouched, or every green chart in the product just
    // changed colour.
    for (const bar of drawn({ data: [{ month: "Jan", net: 120 }, { month: "Feb", net: 80 }], xKey: "month", series: ["net"] })) {
      expect(bar.fill).toContain("var(--vendo-chart-1");
    }
  });
});

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { RowContext } from "../../src/kit/row.js";
import { sanitizeSeries, sanitizeNumbers } from "../../src/kit/charts/sanitize.js";
import { BarChart } from "../../src/kit/charts/bar.js";
import { LineChart } from "../../src/kit/charts/line.js";
import { DonutChart } from "../../src/kit/charts/donut.js";
import { Sparkline } from "../../src/kit/charts/sparkline.js";
import { Progress } from "../../src/kit/charts/progress.js";

describe("sanitize", () => {
  it("nulls non-finite series values so recharts never plots $NaN", () => {
    const rows = [
      { x: "Jan", v: 10 },
      { x: "Feb", v: Number.NaN },
      { x: "Mar", v: Number.POSITIVE_INFINITY },
    ];
    const clean = sanitizeSeries(rows, ["v"]);
    expect(clean[0]!.v).toBe(10);
    expect(clean[1]!.v).toBeNull();
    expect(clean[2]!.v).toBeNull();
  });

  it("drops non-finite numbers from a number list", () => {
    expect(sanitizeNumbers([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toEqual([1, 3]);
  });
});

describe("chart empty/invalid states (never a broken chart)", () => {
  it("LineChart shows a designed empty state with no data", () => {
    render(<LineChart data={[]} xKey="x" series={["v"]} emptyState="No trend yet" />);
    expect(screen.getByText("No trend yet")).toBeTruthy();
  });

  it("BarChart shows the empty state when every value is invalid", () => {
    render(
      <BarChart
        data={[{ x: "Jan", v: Number.NaN }]}
        xKey="x"
        series={["v"]}
        emptyState="No data"
      />,
    );
    expect(screen.getByText("No data")).toBeTruthy();
  });

  it("DonutChart shows the empty state with all-zero slices", () => {
    render(<DonutChart data={[{ label: "A", value: 0 }]} categoryKey="label" valueKey="value" emptyState="Nothing" />);
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("DonutChart shows the empty state (never crashes) when data is undefined or not an array", () => {
    // 0.4.x E2E defect D6: a generated app bound an empty/failed query into a
    // donut and the node error-boxed on `undefined.map`.
    render(
      <DonutChart
        data={undefined as unknown as Array<Record<string, unknown>>}
        categoryKey="label"
        valueKey="value"
        emptyState="No data yet"
      />,
    );
    expect(screen.getByText("No data yet")).toBeTruthy();
    render(
      <DonutChart
        data={"nope" as unknown as Array<Record<string, unknown>>}
        categoryKey="label"
        valueKey="value"
        emptyState="Still no data"
      />,
    );
    expect(screen.getByText("Still no data")).toBeTruthy();
  });

  it("Sparkline renders nothing renderable as an empty state", () => {
    render(<Sparkline data={[Number.NaN]} emptyState="—" />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("chart happy path renders a container", () => {
  it("LineChart renders its wrapper for valid data", () => {
    const { container } = render(<LineChart data={[{ x: "Jan", v: 10 }, { x: "Feb", v: 20 }]} xKey="x" series={["v"]} />);
    expect(container.querySelector('[data-kit="LineChart"]')).not.toBeNull();
  });
});

describe("Progress", () => {
  it("renders a ratio as a percentage label and clamps to 100%", () => {
    render(<Progress value={0.75} showValue />);
    expect(screen.getByText("75%")).toBeTruthy();
  });

  it("supports value/max form", () => {
    render(<Progress value={30} max={60} showValue />);
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("renders a placeholder for a non-finite value", () => {
    const { container } = render(<Progress value={Number.NaN} />);
    expect(container.textContent).not.toContain("NaN");
  });
});

describe("DonutChart legend", () => {
  const spend = [
    { label: "rent", value: 1200 },
    { label: "ACME Corp", value: 340 },
  ];

  // The legend names a slice the way the DATA spells it, which is what the
  // slice's own tooltip shows. Humanizing it lowercased proper nouns and made
  // the two disagree on the same ring.
  it("names and values every slice by default, in the data's own words", () => {
    // An unlabelled ring says nothing in a screenshot: a tooltip is not a label.
    render(<DonutChart data={spend} categoryKey="label" valueKey="value" format="money" />);
    expect(screen.getByText("rent")).toBeTruthy();
    expect(screen.getByText("$1,200.00")).toBeTruthy();
    expect(screen.getByText("ACME Corp")).toBeTruthy();
    expect(screen.getByText("$340.00")).toBeTruthy();
  });

  it("legend={false} leaves the bare ring", () => {
    const { container } = render(
      <DonutChart data={spend} categoryKey="label" valueKey="value" format="money" legend={false} />,
    );
    expect(container.querySelector('[data-kit="DonutLegend"]')).toBeNull();
    expect(container.textContent).not.toContain("rent");
  });
});

/**
 * jsdom lays nothing out, so recharts' ResponsiveContainer measures zero and
 * draws no SVG at all. State the size its observer reports and the real chart
 * renders — the component still picks its own colors.
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

describe("Sparkline tone", () => {
  const stroke = (node: ReactElement): string | null =>
    render(node).container.querySelector(".recharts-area-curve")!.getAttribute("stroke");

  it("paints the line from the palette, and keeps the series color without a tone", () => {
    const restore = stubChartSize(200, 40);
    try {
      expect(stroke(<Sparkline data={[1, 5, 3]} tone="danger" />)).toContain("var(--vendo-color-danger");
      expect(stroke(<Sparkline data={[1, 5, 3]} />)).toContain("var(--vendo-color-accent");
    } finally {
      restore();
    }
  });
});

describe("charts in a cell slot", () => {
  it("Sparkline plots the row's series instead of its own prop", () => {
    const { container } = render(
      <RowContext.Provider value={{ history: [1, 5, 3] }}>
        <Sparkline data={[]} field="history" emptyState="nothing" />
      </RowContext.Provider>,
    );
    expect(container.querySelector('div[data-kit="Sparkline"]')).not.toBeNull();
    expect(container.textContent).not.toContain("nothing");
  });

  it("Progress reads the row's value, and its own outside a row", () => {
    render(
      <RowContext.Provider value={{ used: 0.25 }}>
        <Progress value={0.9} field="used" showValue />
      </RowContext.Provider>,
    );
    expect(screen.getByText("25%")).toBeTruthy();
    render(<Progress value={0.9} field="used" showValue />);
    expect(screen.getByText("90%")).toBeTruthy();
  });
});

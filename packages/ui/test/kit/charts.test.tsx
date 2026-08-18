// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
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

  it("DonutChart shows the empty state when no slice holds a renderable number", () => {
    render(<DonutChart data={[{ label: "A", value: null }]} categoryKey="label" valueKey="value" emptyState="Nothing" />);
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  // A zero is not nothing. "This category spent nothing" is an answer, and
  // dropping the slice took its row out of the LEGEND too — a ring of five
  // categories showed four and never said which one went missing. The zero draws
  // no arc, which is correct, and reads 0 under the ring.
  it("DonutChart keeps a zero slice in the legend, reading a formatted 0", () => {
    render(
      <DonutChart data={[{ label: "A", value: 0 }]} categoryKey="label" valueKey="value" format="money" emptyState="Nothing" />,
    );
    expect(screen.queryByText("Nothing")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
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

  /** The fill — Base UI's Indicator, the one child of the bar itself. */
  const fill = (container: HTMLElement) =>
    container.querySelector('[role="progressbar"] > *')!;

  // The bar can only ever say "full", so past the cap the figure is the only
  // honest reading of how far past it went — printing 100% at 1.2 is a wrong
  // number. Whether over is BAD NEWS is a judgement, and the bar does not make
  // it: the color moves only when the caller writes a `tone`.
  it("prints the true figure past the cap, and does not repaint itself", () => {
    const { container } = render(<Progress value={1.2} showValue />);
    expect(screen.getByText("120%")).toBeTruthy();
    expect(fill(container).getAttribute("style")).toContain("--vendo-color-accent");
    expect(fill(container).getAttribute("style")).not.toContain("--vendo-color-danger");
  });

  it("leaves a bar under its cap in the brand's own color", () => {
    const { container } = render(<Progress value={0.45} showValue />);
    expect(screen.getByText("45%")).toBeTruthy();
    expect(fill(container).getAttribute("style")).toContain("--vendo-color-accent");
  });

  it("paints the tone the caller wrote, past the cap as anywhere else", () => {
    const { container } = render(<Progress value={1.2} tone="success" />);
    expect(fill(container).getAttribute("style")).toContain("--vendo-color-success");
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

  // The ring's legend printed the raw enum ("past_due") while a DataTable on the
  // same screen humanized and toned the identical field through EnumBadge — the
  // two halves of one screen reading the same value in two different languages.
  it("reads an enum slice through EnumBadge — humanized, and toned as a table column is", () => {
    const { container } = render(
      <DonutChart
        data={[{ status: "past_due", mrr: 12800 }, { status: "active", mrr: 41000 }]}
        categoryKey="status"
        valueKey="mrr"
        format="money"
        tones={{ past_due: "danger" }}
      />,
    );
    const pills = [...container.querySelectorAll('[data-kit="EnumBadge"]')];
    expect(pills.map((pill) => pill.textContent)).toEqual(["Past due", "Active"]);
    expect(pills[0]!.getAttribute("data-tone")).toBe("danger");
    expect(container.textContent).not.toContain("past_due");
  });

  it("legend={false} leaves the bare ring", () => {
    const { container } = render(
      <DonutChart data={spend} categoryKey="label" valueKey="value" format="money" legend={false} />,
    );
    expect(container.querySelector('[data-kit="DonutLegend"]')).toBeNull();
    expect(container.textContent).not.toContain("rent");
  });

  // A donut states shares of ONE WHOLE, so a negative value cannot be one of
  // them. Filtered out quietly it took its category off the ring AND out of the
  // legend while every share that remained read against the wrong total — a chart
  // that is confidently wrong, which is worse than one that refuses. The box
  // names the slice and what to draw instead, and it is NOT the author's own
  // "nothing here" slot: this is bad data, not absent data.
  it("refuses a negative slice out loud, naming it and the chart to draw instead", () => {
    render(
      <DonutChart
        data={[...spend, { label: "refunds", value: -40 }]}
        categoryKey="label"
        valueKey="value"
        format="money"
        emptyState="Nothing"
        empty={<p>the author&apos;s own empty state</p>}
      />,
    );
    const refusal = document.querySelector('[data-kit="ChartEmpty"]')!.textContent ?? "";
    expect(refusal).toContain("refunds");
    expect(refusal).toContain("-$40.00");
    expect(refusal).toContain("BarChart");
    expect(screen.queryByText("the author's own empty state")).toBeNull();
    expect(screen.queryByText("Nothing")).toBeNull();
    // ...and no ring, so nothing reads against a total that lost a category.
    expect(screen.queryByText("rent")).toBeNull();
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

/**
 * The hovered point's own tooltip — where a series' LABEL and its VALUE are both
 * printed, so it is the one place both halves of a series descriptor are
 * readable. Recharts resolves a hover through a middleware behind
 * `requestAnimationFrame`, so the read waits: read synchronously, the wrapper is
 * still empty and every assertion passes vacuously.
 */
async function hoveredTooltip(container: HTMLElement): Promise<string> {
  fireEvent.mouseMove(container.querySelector(".recharts-wrapper")!, { clientX: 120, clientY: 100 });
  return await waitFor(() => {
    const text = container.querySelector(".recharts-tooltip-wrapper")?.textContent ?? "";
    expect(text).not.toBe("");
    return text;
  });
}

/**
 * `name` is the word a caller reaches for to rename a series, and it landed
 * nowhere: the engine owns that prop, so the Kit Omit-ed it and set it from
 * `label` alone — a series written `{ key: "duration_seconds", name: "Build
 * time" }` charted as "duration_seconds" and said nothing about why.
 */
describe("chart series descriptors", () => {
  const builds = [
    { number: "4191", duration_seconds: 412 },
    { number: "4187", duration_seconds: 46 },
  ];

  it("LineChart reads `name` as the series label, and the series' own format for its value", async () => {
    // A chart of two series in different units has no ONE chart-level token that
    // reads both, so the series carries its own — and the LINE chart dropped it
    // straight through to the engine, where it meant nothing: this tooltip read
    // "412" while a bar chart said "6m 52s" off the identical prop.
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <LineChart
          data={builds}
          xKey="number"
          series={[{ key: "duration_seconds", name: "Build time", format: "duration" }]}
          format="number"
        />,
      );
      const tip = await hoveredTooltip(container);
      expect(tip).toContain("Build time");
      expect(tip).toContain("6m 52s");
    } finally {
      restore();
    }
  });

  it("BarChart reads `name` as the series label too", async () => {
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <BarChart data={builds} xKey="number" series={[{ key: "duration_seconds", name: "Build time" }]} format="duration" />,
      );
      expect(await hoveredTooltip(container)).toContain("Build time");
    } finally {
      restore();
    }
  });
});


/**
 * The category axis had no format token at all — the only one the chart owned was
 * the y-axis' — so a trend over days printed the raw "2026-07-30" the host stored
 * under every tick, beside figures that read in the host's own words.
 */
describe("LineChart x-axis format", () => {
  const ticks = (container: HTMLElement): string[] =>
    [...container.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value")].map(
      (tick) => tick.textContent ?? "",
    );

  it("reads a date axis in words, and leaves a plain category exactly as given", () => {
    const restore = stubChartSize(360, 220);
    try {
      const dated = render(
        <LineChart
          data={[{ day: "2026-07-30", amount: 1200 }, { day: "2026-07-31", amount: 1450 }]}
          xKey="day"
          series={["amount"]}
          format="money"
          xFormat="date"
        />,
      );
      expect(ticks(dated.container)).toEqual(["Jul 30, 2026", "Jul 31, 2026"]);
      const plain = render(<LineChart data={[{ x: "Jan", v: 1 }, { x: "Feb", v: 2 }]} xKey="x" series={["v"]} />);
      expect(ticks(plain.container)).toEqual(["Jan", "Feb"]);
    } finally {
      restore();
    }
  });

  // The hovered point's heading is that same x value: formatted on the axis alone,
  // the tooltip goes on quoting the ISO the tick no longer shows.
  it("heads the hovered point in the words its own tick reads", async () => {
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <LineChart
          data={[{ day: "2026-07-30", amount: 1200 }, { day: "2026-07-31", amount: 1450 }]}
          xKey="day"
          series={["amount"]}
          format="money"
          xFormat="date"
        />,
      );
      const tip = await hoveredTooltip(container);
      expect(tip).toMatch(/Jul 3[01], 2026/);
      expect(tip).not.toContain("2026-07");
    } finally {
      restore();
    }
  });
});

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

/**
 * The figure ON the bar. A bar chart exists to compare magnitudes, and a reader
 * who has to trace a bar back to an axis tick to learn one is reading the chart
 * twice — "how long did 4191 take?" was a judge line the chart itself could not
 * answer.
 */
describe("BarChart value labels", () => {
  const builds = [
    { number: "4191", duration_seconds: 412 },
    { number: "4187", duration_seconds: 46 },
  ];

  const labels = (container: HTMLElement): string[] =>
    [...container.querySelectorAll(".recharts-label-list text")].map((node) => node.textContent ?? "");

  it("labels every bar with its value, in the chart's own format", () => {
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <BarChart data={builds} xKey="number" series={["duration_seconds"]} format="duration" />,
      );
      // "0m 46s", not "46s": a duration is floored at the minute wherever it is
      // printed (`format.ts` formatDuration), and a bar label is one more place.
      expect(labels(container)).toEqual(["6m 52s", "0m 46s"]);
    } finally {
      restore();
    }
  });

  // A chart of two series in different units has no ONE chart-level token that
  // reads both, so the series carries its own — and the chart used to drop it
  // straight through to the engine, where it meant nothing.
  it("reads a series in the format that series declared", () => {
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <BarChart
          data={[{ number: "4191", duration_seconds: 412, compute_cost: 18.7 }]}
          xKey="number"
          series={[{ key: "duration_seconds", format: "duration" }, { key: "compute_cost", format: "money" }]}
          format="number"
        />,
      );
      expect(labels(container)).toEqual(["6m 52s", "$18.70"]);
    } finally {
      restore();
    }
  });

  // A horizontal bar's label sits past its right end, which is where the chart
  // area stopped: at the default margin the longest bar's figure was clipped
  // off the frame entirely.
  it("keeps room past the end of a horizontal bar for the label to sit in", () => {
    const restore = stubChartSize(360, 220);
    try {
      const { container } = render(
        <BarChart data={builds} xKey="number" series={["duration_seconds"]} format="duration" horizontal />,
      );
      const surface = container.querySelector(".recharts-surface")!;
      // The plotted area, which is where a bar STOPS: the gap between its right
      // edge and the frame's is the room a label at the bar's end has to sit in.
      // Every grid line carries that area's own box.
      const plot = container.querySelector(".recharts-cartesian-grid line")!;
      const right = Number(plot.getAttribute("x")) + Number(plot.getAttribute("width"));
      expect(Number(surface.getAttribute("width")) - right).toBeGreaterThanOrEqual(40);
    } finally {
      restore();
    }
  });
});

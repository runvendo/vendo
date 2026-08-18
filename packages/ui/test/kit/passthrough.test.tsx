// @vitest-environment jsdom
/**
 * Passthrough styling, component by component: `style` on every brick in the
 * registry, and the wrapped engine's own props on the ones that render one.
 *
 * The registry drives the table, so a component added tomorrow is covered the
 * day it is created — the failure this guards against is the silent one, where
 * a prop validates, crosses the wire and is dropped by the component that never
 * threaded it through.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { KIT_COMPONENTS } from "../../src/kit/registry.js";
import { BarChart } from "../../src/kit/charts/bar.js";
import { DonutChart } from "../../src/kit/charts/donut.js";
import { LineChart } from "../../src/kit/charts/line.js";
import { Sparkline } from "../../src/kit/charts/sparkline.js";
import { Stack } from "../../src/kit/layout.js";
import { Checkbox } from "../../src/kit/forms/checkbox.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";
import { Switch } from "../../src/kit/forms/switch.js";
import { Textarea } from "../../src/kit/forms/textarea.js";

afterEach(cleanup);

/**
 * jsdom lays nothing out, so recharts' ResponsiveContainer measures zero and
 * draws no SVG at all (charts.test.tsx documents the same stub). State the size
 * its observer reports and the real chart renders.
 */
const stubChartSize = (width: number, height: number): (() => void) => {
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
};

const points = [{ m: "Jan", v: 1 }, { m: "Feb", v: 5 }];
const series = { data: points, xKey: "m", series: ["v"] };

/** The least each component needs to paint something. Everything absent from
 *  here renders on its defaults alone. */
const PROPS: Readonly<Record<string, Record<string, unknown>>> = {
  Icon: { name: "check" },
  // The text tier paints a placeholder, or nothing at all, with no value to show.
  Text: { text: "Overdue" },
  EnumBadge: { value: "overdue" },
  Badge: { label: "Overdue" },
  DataTable: { rows: [{ client: "Ada" }] },
  CardList: { items: [{ name: "Ada" }], titleField: "name" },
  Stat: { label: "Open", value: 3 },
  KeyValue: { record: { plan: "pro" } },
  Timeline: { entries: [{ title: "Filed" }], titleField: "title" },
  Avatar: { name: "Ada Lovelace" },
  CodeBlock: { code: "const x = 1;" },
  LineChart: series,
  BarChart: series,
  DonutChart: { data: [{ c: "rent", v: 5 }], categoryKey: "c", valueKey: "v" },
  Sparkline: { data: [1, 5, 3] },
  Select: { options: ["A", "B"] },
  Radio: { options: ["A", "B"] },
  Combobox: { options: ["A", "B"] },
  SegmentedControl: { items: ["A", "B"] },
  Button: { label: "Go" },
  Link: { to: "/invoices" },
  Disclaimer: { reason: "no tool backs this" },
  Tabs: { tabs: ["Overview", "Detail"] },
  Accordion: { items: [{ label: "Why", content: "because" }] },
  Menu: { label: "Actions" },
  EmptyState: { title: "Nothing here" },
  Steps: { items: [{ label: "One" }] },
  Modal: { open: true, onClose: () => undefined },
  Sheet: { open: true, onClose: () => undefined },
  Toast: { open: true, message: "Sent." },
};

/** A declaration no Kit component would ever paint on its own. */
const SENTINEL = { outlineColor: "rgb(1, 2, 3)" };
const PAINTED = "outline-color: rgb(1, 2, 3)";

describe("every component in the registry takes a style", () => {
  const restore = stubChartSize(240, 120);
  afterEach(() => cleanup());

  for (const [name, implementation] of Object.entries(KIT_COMPONENTS)) {
    // The registry is typed for the RENDERER, which knows no component's props;
    // this table knows each one's, so it reads the same map back open.
    const Component = implementation as ComponentType<Record<string, unknown>>;
    it(`merges an inline style onto <${name}>'s root`, () => {
      const props = PROPS[name] ?? {};
      render(<Component {...props} style={SENTINEL} />);
      expect(document.body.innerHTML, `${name} dropped its style`).toContain(PAINTED);
      cleanup();
      // Absent, the component paints exactly what it painted before.
      render(<Component {...props} />);
      expect(document.body.innerHTML, `${name} paints the sentinel unasked`).not.toContain(PAINTED);
    });
  }

  it("keeps the theme's own declarations beside the caller's, and loses the ties", () => {
    const { container } = render(<Stack gap={12} style={{ background: "rgb(9, 9, 9)", gap: "40px" }} />);
    const root = container.querySelector('[data-kit="Stack"]') as HTMLElement;
    // Merged, not replaced: the layout the component owns survives.
    expect(root.style.display).toBe("flex");
    expect(root.style.background).toBe("rgb(9, 9, 9)");
    // And where they collide, the caller wins.
    expect(root.style.gap).toBe("40px");
  });

  restore();
});

describe("a chart's engine props reach the engine", () => {
  const stroke = (selector: string) =>
    [...document.querySelectorAll(selector)].map((node) => node.getAttribute("stroke"));

  it("puts a Sparkline's stroke on the recharts Area, and keeps the theme's without one", () => {
    const restore = stubChartSize(200, 40);
    try {
      render(<Sparkline data={[1, 5, 3]} stroke="#FF3B30" strokeWidth={4} />);
      expect(stroke(".recharts-area-curve")).toEqual(["#FF3B30"]);
      expect(document.querySelector(".recharts-area-curve")?.getAttribute("stroke-width")).toBe("4");
      cleanup();
      render(<Sparkline data={[1, 5, 3]} />);
      expect(stroke(".recharts-area-curve")[0]).toContain("var(--vendo-color-accent");
    } finally {
      restore();
    }
  });

  it("treats an engine prop that was never really set as absent", () => {
    // `<Sparkline stroke={brand?.accent}/>` with nothing behind it is a prop
    // React calls unset — and a spread that carried the `undefined` through would
    // land it ON the Kit's default and blank it, dropping the chart to RECHARTS'
    // own blue. The host asked for nothing and must get their own theme.
    const restore = stubChartSize(200, 40);
    try {
      render(<Sparkline data={[1, 5, 3]} stroke={undefined} strokeWidth={undefined} />);
      const curve = document.querySelector(".recharts-area-curve")!;
      expect(curve.getAttribute("stroke")).toContain("var(--vendo-color-accent");
      expect(curve.getAttribute("stroke-width")).toBe("1.5");
    } finally {
      restore();
    }
  });

  it("colors one line of a LineChart from its own series descriptor", () => {
    const restore = stubChartSize(400, 200);
    try {
      render(
        <LineChart
          data={[{ m: "Jan", a: 1, b: 2 }, { m: "Feb", a: 5, b: 4 }]}
          xKey="m"
          series={[{ key: "a", label: "Revenue", stroke: "#FF3B30" }, "b"]}
        />,
      );
      const [first, second] = stroke(".recharts-line-curve");
      expect(first).toBe("#FF3B30");
      // The series that asked for nothing still paints from the host's palette.
      expect(second).toContain("var(--vendo-chart-2");
    } finally {
      restore();
    }
  });

  it("puts the style on the same root whether the chart has points or not", () => {
    // A chart with nothing to plot returns its empty state INSTEAD of its own
    // root, so the caller's style has to land on that one too — on a nested box
    // it was layout the populated chart applied and the empty one did not, and a
    // chart that lost its data moved on the page.
    const restore = stubChartSize(400, 200);
    const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;
    try {
      const populated = render(<LineChart {...series} style={{ marginTop: "13px" }} />);
      expect(root(populated.container).style.marginTop).toBe("13px");
      cleanup();
      const empty = render(<LineChart data={[]} xKey="m" series={["v"]} style={{ marginTop: "13px" }} />);
      expect(root(empty.container).style.marginTop).toBe("13px");
    } finally {
      restore();
    }
  });

  it("paints every bar from a chart-level recharts prop", () => {
    const restore = stubChartSize(400, 200);
    try {
      render(<BarChart {...series} fill="#FF3B30" />);
      expect(document.querySelector(".recharts-bar-rectangle path")?.getAttribute("fill")).toBe("#FF3B30");
    } finally {
      restore();
    }
  });

  it("passes a recharts prop to a DonutChart's Pie", () => {
    const restore = stubChartSize(400, 200);
    try {
      render(<DonutChart data={[{ c: "rent", v: 5 }]} categoryKey="c" valueKey="v" legend={false} strokeWidth={7} />);
      expect(document.querySelector(".recharts-pie-sector path")?.getAttribute("stroke-width")).toBe("7");
    } finally {
      restore();
    }
  });
});

describe("a Base UI component's engine props reach the Base UI part", () => {
  it("puts an unmodelled attribute on the Input's own element", () => {
    const { container } = render(<Input label="Amount" inputMode="decimal" />);
    expect(container.querySelector('input[data-kit="Input"]')?.getAttribute("inputmode")).toBe("decimal");
  });

  it("leaves the Kit's own wiring alone — a passthrough cannot rename the control", () => {
    const { container } = render(<Input label="Amount" type="email" inputMode="decimal" />);
    const input = container.querySelector('input[data-kit="Input"]')!;
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });

  it("puts one on each of the three controls that are still NATIVE", () => {
    // Input's passthrough is Base UI's; Textarea, Select and Checkbox render a
    // plain DOM element, so what goes through is that element's own attribute set.
    const { container } = render(
      <>
        <Textarea label="Note" maxLength={140} />
        <Select label="Client" options={["Hartwell"]} name="client" />
        <Checkbox label="Paid" name="paid" />
      </>,
    );
    expect(container.querySelector('textarea[data-kit="Textarea"]')?.getAttribute("maxlength")).toBe("140");
    expect(container.querySelector('select[data-kit="Select"]')?.getAttribute("name")).toBe("client");
    expect(container.querySelector('input[data-kit="Checkbox"]')?.getAttribute("name")).toBe("paid");
  });

  it("leaves the Kit's own wiring alone — a passthrough cannot rename a native control either", () => {
    // The compiler already omits `type` and never asked for `id`, but the WIRE
    // lets an engine's props through by NAME, so the guard has to hold at render
    // too: `type` is what makes the control a checkbox, and the id is one half of
    // the wiring the label is the other half of.
    const Loose = Checkbox as ComponentType<Record<string, unknown>>;
    const { container } = render(<Loose label="Paid" type="radio" id="mine" />);
    const box = container.querySelector('input[data-kit="Checkbox"]') as HTMLInputElement;

    expect(box.type).toBe("checkbox");
    expect(box.id).not.toBe("mine");
    expect(container.querySelector(`label[for="${box.id}"]`)?.textContent).toBe("Paid");
  });

  it("hands one to Base UI and lets Base UI place it", () => {
    const { container } = render(<Switch label="Auto-pay" name="autopay" readOnly />);
    // `readOnly` marks the control itself; `name` is the one a form submits under,
    // which Base UI puts on the hidden input it keeps for exactly that. Both are
    // the ENGINE deciding where its own prop belongs — which is the point.
    expect(container.querySelector('[data-kit="Switch"]')?.getAttribute("aria-readonly")).toBe("true");
    expect(container.querySelector('input[name="autopay"]')).not.toBeNull();
  });
});

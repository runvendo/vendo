// @vitest-environment jsdom
/**
 * Passthrough styling across the seam it really has to cross.
 *
 * A generated app's `style` and engine props are written in TSX, serialized by
 * the screen VM as ordinary JSON props, flattened into a tree, and handed to the
 * Kit by the renderer — four hands, and until they meet, "the component takes
 * `stroke`" is a claim about a unit test rather than about the product. So
 * nothing here is stubbed on either side: real sucrase, the real QuickJS engine
 * from `@vendoai/apps/contract`, the real flatten the server does, the real
 * `PayloadView`, the real Kit and the real recharts.
 *
 * The failure it exists to catch is silent: props that validate, cross the wire
 * and are dropped by whatever paints last, leaving an app that passed every gate
 * and ignored every color the person asked for.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { transform } from "sucrase";
import { bootScreen, flattenTree, kitSpec, validateProps, warmScreenEngine } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type ToolOutcome, type TreeNode, type UIPayload } from "@vendoai/core";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

beforeAll(async () => {
  await warmScreenEngine();
}, 30_000);

/** jsdom lays nothing out, so recharts' ResponsiveContainer measures zero and
 *  draws no SVG at all. State the size its observer reports and the real chart
 *  renders (`test/kit/charts.test.tsx` carries the same stub). */
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

const compile = (tsx: string): string =>
  transform(tsx, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "automatic" }).code;

const CATALOG = ["Stack", "Card", "Text", "Sparkline", "LineChart"];

/** The screen a model writes when the person asked for particular colors: the
 *  theme everywhere else, and three deliberate deviations. */
const BRANDED = `
import { Card, LineChart, Sparkline, Stack, Text, useQuery } from "@vendo/screen";

export default function Revenue() {
  const revenue = useQuery("revenue");
  return (
    <Stack gap={12}>
      <Card title="Revenue" style={{ borderColor: "rgb(255, 59, 48)" }}>
        <Text text="Last two months" />
        <Sparkline data={revenue.data.map((row) => row.amount)} stroke="#FF3B30" />
        <LineChart
          data={revenue.data}
          xKey="month"
          series={[{ key: "amount", label: "Revenue", stroke: "#0A84FF" }]}
        />
      </Card>
    </Stack>
  );
}
`;

/** The same screen with every appearance prop taken away — the theme's own
 *  paint, which is what an app that asked for nothing must still get. */
const PLAIN = BRANDED
  .replace(' style={{ borderColor: "rgb(255, 59, 48)" }}', "")
  .replace(' stroke="#FF3B30"', "")
  .replace(', stroke: "#0A84FF"', "");

/**
 * The same ask, in the DIALECT a model actually writes it in: a palette const and
 * a `series` built from it by `.map`, with the colour under the one word anybody
 * reaches for. This is the shape the store's "All balances chart"
 * (app_9b197e3d-7ad9-4a4d-9a76-d99d5180b860) carries, and the one that painted
 * all seven of its lines from the theme.
 */
const COLORED = `
import { LineChart, Stack, useQuery } from "@vendo/screen";

const COLORS = ["#e11d48", "#f97316"];

export default function Balances() {
  const accounts = useQuery("revenue");
  const series = COLORS.map((color, i) => ({ key: "acc_" + i, label: "Account " + i, color }));
  return (
    <Stack gap={12}>
      <LineChart data={accounts.data} xKey="month" series={series} format="money" />
    </Stack>
  );
}
`;

const ROWS = [{ month: "Jan", amount: 1_200 }, { month: "Feb", amount: 1_900 }];
const PALETTE_ROWS = [
  { month: "Jan", acc_0: 1_200, acc_1: 900 },
  { month: "Feb", acc_0: 1_900, acc_1: 1_400 },
];

const paint = (source: string, rows: Array<Record<string, unknown>> = ROWS) => {
  const queries = { revenue: { data: rows } };
  const compiledSource = compile(source);
  const first = bootScreen({ compiledSource, queries, catalog: CATALOG, now: Date.UTC(2026, 1, 1) });
  let payload: UIPayload;
  let nodes: TreeNode[];
  try {
    const flat = flattenTree(first.tree());
    nodes = Object.values(flat.nodes);
    payload = {
      formatVersion: VENDO_TREE_FORMAT,
      root: flat.root,
      nodes,
      interactive: { compiledSource, queries },
    } as unknown as UIPayload;
  } finally {
    first.dispose();
  }
  return {
    nodes,
    ...render(
      <PayloadView
        payload={payload}
        components={{}}
        onAction={async (): Promise<ToolOutcome> => ({ status: "ok", output: null })}
      />,
    ),
  };
};

describe("a generated app's own colors survive the whole chain", () => {
  it("paints the style and both engine props the screen source asked for", () => {
    const restore = stubChartSize(360, 180);
    try {
      const { container } = paint(BRANDED);

      // `style` reached the Card's root, and did not cost it the theme's own
      // layout — a replaced style object would have taken the padding with it.
      const card = container.querySelector('[data-kit="Card"]') as HTMLElement;
      expect(card.style.borderColor).toBe("rgb(255, 59, 48)");
      expect(card.style.display).toBe("flex");

      // The engine props reached recharts itself.
      expect(container.querySelector(".recharts-area-curve")?.getAttribute("stroke")).toBe("#FF3B30");
      expect(container.querySelector(".recharts-line-curve")?.getAttribute("stroke")).toBe("#0A84FF");
    } finally {
      restore();
    }
  });

  it("paints the host's theme through the same chain when the screen asks for nothing", () => {
    const restore = stubChartSize(360, 180);
    try {
      const { container } = paint(PLAIN);

      const card = container.querySelector('[data-kit="Card"]') as HTMLElement;
      expect(card.style.borderColor).toBe("");
      expect(card.style.display).toBe("flex");
      expect(container.querySelector(".recharts-area-curve")?.getAttribute("stroke")).toContain("var(--vendo-color-accent");
      expect(container.querySelector(".recharts-line-curve")?.getAttribute("stroke")).toContain("var(--vendo-chart-1");
    } finally {
      restore();
    }
  });

  it("paints per-series colors written the way a model writes them", () => {
    const restore = stubChartSize(360, 180);
    try {
      const { container, nodes } = paint(COLORED, PALETTE_ROWS);

      // The WIRE gate keeps them. A schema that stripped `color` would leave the
      // renderer nothing to paint from, and the DOM check below would then be
      // asserting against the theme's palette rather than the app's own.
      const chart = nodes.find((node) => node.component === "LineChart");
      const wire = validateProps(kitSpec("LineChart")!, chart?.props);
      expect(wire.success).toBe(true);
      expect(wire.data?.series).toEqual([
        { key: "acc_0", label: "Account 0", color: "#e11d48" },
        { key: "acc_1", label: "Account 1", color: "#f97316" },
      ]);

      // And the renderer paints them: not one of these is a theme token.
      expect([...container.querySelectorAll(".recharts-line-curve")].map((line) => line.getAttribute("stroke")))
        .toEqual(["#e11d48", "#f97316"]);
    } finally {
      restore();
    }
  });
});

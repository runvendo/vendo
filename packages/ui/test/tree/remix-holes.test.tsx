// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Area, AreaChart } from "recharts";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";
import { VendoProvider } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree & { formatVersion: typeof VENDO_TREE_FORMAT } =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: "root", nodes });

/** A host's own sub-component — one of the two kinds of hole the splitter emits
 *  (`actions` sync/split/port.ts: an imported binding used as a JSX tag). */
function PriceBadge({ amount }: { amount?: number }) {
  return <b data-testid="badge">{`$${amount ?? 0}`}</b>;
}

/** The npm kind, nested exactly as a host writes it: the chart and its curve are
 *  two separate holes, so they arrive as two separate nodes. */
const CHART_NODES: WalkTree["nodes"] = [
  { id: "root", component: "Stack", children: ["chart"] },
  {
    id: "chart",
    component: "AreaChart",
    props: { width: 320, height: 180, data: [{ month: "Jan", value: 3 }, { month: "Feb", value: 8 }] },
    children: ["curve"],
  },
  { id: "curve", component: "Area", props: { dataKey: "value", isAnimationActive: false } },
];

/** The generated `.vendo/generated/remix-wiring.ts` const, as the host imports it
 *  and hands to BOTH `createVendo` and the provider — `tools` included, because
 *  the host passes the whole thing rather than picking it apart. */
const WIRING = {
  SpendCard: { tools: {}, holes: { AreaChart, Area } },
  AccountRow: { tools: {}, holes: { PriceBadge } },
} as const;

const slotPayload = (nodes: WalkTree["nodes"]): UIPayload =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: "root", nodes } as UIPayload);

describe("a hole resolves by name in the renderer", () => {
  it("paints a host sub-component hole", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["badge"] },
          { id: "badge", component: "PriceBadge", props: { amount: 42 } },
        ])}
        components={{ PriceBadge: PriceBadge as ComponentType }}
        onAction={ok}
      />,
    );
    expect(screen.getByTestId("badge").textContent).toBe("$42");
  });

  it("paints a composite npm hole — recharts draws the curve its child node declared", () => {
    render(
      <TreeView
        tree={tree(CHART_NODES)}
        components={{ AreaChart: AreaChart as ComponentType, Area: Area as ComponentType }}
        onAction={ok}
      />,
    );
    expect(document.querySelector("path.recharts-area-area")).not.toBeNull();
  });

  it("says so rather than painting nothing when the hole was never registered", () => {
    render(<TreeView tree={tree(CHART_NODES)} components={{}} onAction={ok} />);
    expect(screen.getByRole("note", { name: "Unknown component" }).textContent).toContain("AreaChart");
  });
});

describe("the generated wiring carries its holes to the renderer", () => {
  it("paints an npm hole the host only ever registered as wiring", () => {
    render(
      <VendoProvider remixWiring={WIRING}>
        <VendoSlot id="hero" pin={{ payload: slotPayload(CHART_NODES) }} />
      </VendoProvider>,
    );
    expect(document.querySelector("path.recharts-area-area")).not.toBeNull();
  });

  it("paints a host sub-component hole the host only ever registered as wiring", () => {
    render(
      <VendoProvider remixWiring={WIRING}>
        <VendoSlot id="hero" pin={{ payload: slotPayload([{ id: "root", component: "PriceBadge", props: { amount: 7 } }]) }} />
      </VendoProvider>,
    );
    expect(screen.getByTestId("badge").textContent).toBe("$7");
  });

  it("lets an explicit components entry win, exactly as it wins over a hole in the server's catalog", () => {
    render(
      <VendoProvider
        remixWiring={WIRING}
        components={{ PriceBadge: (() => <b data-testid="badge">the host's own</b>) as ComponentType<never> }}
      >
        <VendoSlot id="hero" pin={{ payload: slotPayload([{ id: "root", component: "PriceBadge", props: { amount: 7 } }]) }} />
      </VendoProvider>,
    );
    expect(screen.getByTestId("badge").textContent).toBe("the host's own");
  });
});

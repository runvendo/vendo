// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: nodes[0]!.id, nodes } as WalkTree);

/** The host's own chart, as the generated wiring registers it: an npm or
 *  sub-component hole that happens to wear a Kit name — the splitter zoo's own
 *  `Sparkline`, and every charting library's `LineChart`. */
function HostSparkline({ points }: { points?: string }) {
  return <div data-testid="host-sparkline">{points}</div>;
}

/**
 * A PORTED node resolves a name the wiring declares as a hole to the HOST's
 * component, not the Kit's. The port's `Sparkline` is the host's own (the
 * splitter zoo ports exactly that hole); resolved built-in-first it became
 * Vendo's Kit chart, which throws on the host component's props. A ported
 * node's names are the host's names — structurally, by what the wiring
 * registered, never by any list of library names.
 */
describe("a ported node whose hole wears a Kit name", () => {
  it("resolves the hole the wiring declared, not the Kit built-in", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["c"] },
          { id: "c", component: "Sparkline", source: "ported", props: { points: "1,2,3" } },
        ])}
        components={{ Sparkline: HostSparkline }}
        onAction={ok}
      />,
    );
    expect(screen.getByTestId("host-sparkline").textContent).toBe("1,2,3");
  });

  it("keeps the Kit chart first for a node that is not ported", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["c"] },
          { id: "c", component: "LineChart", props: { data: [], xKey: "x", series: [] } },
        ])}
        components={{ LineChart: HostSparkline }}
        onAction={ok}
      />,
    );
    // The Kit chart with nothing to plot paints its empty state — proof the
    // built-in rendered, not merely that the host component did not.
    expect(screen.queryByTestId("host-sparkline")).toBeNull();
    expect(screen.getByText("No data to chart")).toBeTruthy();
  });
});

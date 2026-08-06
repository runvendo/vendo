// @vitest-environment jsdom
/**
 * The plan-skeleton ↔ Tabs seam.
 *
 * `packages/apps` generation/skeleton.ts emits the app's tab chrome as a TREE
 * node — `{component:"Tabs", props:{tabs:[{value,label}], value}, children:[…panels]}`
 * — and every group of a tabbed app hangs off those panel children. V4 retired
 * the legacy tree primitive that used to serve that shape, so the KIT Tabs
 * carries it now.
 *
 * A harness that mocked either side would prove nothing (CLAUDE.md), so this
 * builds the producer's EXACT node shape and renders it through the real
 * TreeView. If the Kit Tabs ever stops reading `{value,label}` items, `value`,
 * or children-as-panels, a tabbed app silently loses its entire body — which is
 * exactly what this catches.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** Byte-for-byte the node shape skeletonFromPlan writes for a two-tab plan. */
const skeletonShapedTree = (): WalkTree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "app",
  nodes: [
    { id: "app", component: "Stack", source: "prewired", children: ["tabs"] },
    {
      id: "tabs",
      component: "Tabs",
      source: "prewired",
      props: {
        tabs: [{ value: "Overview", label: "Overview" }, { value: "Overdue", label: "Overdue" }],
        value: "Overview",
      },
      children: ["tab-0", "tab-1"],
    },
    { id: "tab-0", component: "Stack", source: "prewired", children: ["group-0"] },
    { id: "tab-1", component: "Stack", source: "prewired", children: ["group-1"] },
    { id: "group-0", component: "Text", source: "prewired", props: { text: "Overview body" } },
    { id: "group-1", component: "Text", source: "prewired", props: { text: "Overdue body" } },
  ],
} as WalkTree);

describe("the plan skeleton's tab chrome renders through the real renderer", () => {
  it("paints both tab labels from {value,label} items", () => {
    render(<TreeView tree={skeletonShapedTree()} components={{}} onAction={ok} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Overdue"]);
  });

  it("shows the panel `value` names — the group body, not an empty bar", () => {
    render(<TreeView tree={skeletonShapedTree()} components={{}} onAction={ok} />);

    // The regression this file exists for: a Tabs that ignores children renders
    // the bar and NOTHING else, so the whole app disappears under its own tabs.
    expect(screen.getByText("Overview body")).toBeTruthy();
    expect(screen.getByRole("tabpanel").textContent).toContain("Overview body");
  });

  it("switches panels on click, with no round trip", () => {
    render(<TreeView tree={skeletonShapedTree()} components={{}} onAction={ok} />);

    fireEvent.click(screen.getByRole("tab", { name: "Overdue" }));

    expect(screen.getByRole("tabpanel").textContent).toContain("Overdue body");
    expect(screen.getByRole("tab", { name: "Overdue" }).getAttribute("aria-selected")).toBe("true");
  });

  it("honors `value` when it names a tab other than the first", () => {
    const tree = skeletonShapedTree();
    (tree.nodes[1] as { props: Record<string, unknown> }).props.value = "Overdue";

    render(<TreeView tree={tree} components={{}} onAction={ok} />);

    expect(screen.getByRole("tabpanel").textContent).toContain("Overdue body");
  });
});

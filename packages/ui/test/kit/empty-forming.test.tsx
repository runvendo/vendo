// @vitest-environment jsdom
/**
 * A table with no rows YET is not a table with no rows. While the build is in
 * flight the empty copy is a lie, so it holds the same skeleton the rest of the
 * forming surface uses — and the moment the paint settles, a genuinely empty
 * component says so again.
 *
 * Both ways of writing that copy are covered, because they are separate return
 * paths: the component's own default (`emptyState`), and the author's own
 * content in the `empty` slot — which a Kit component returns BEFORE it reaches
 * the default, so the author's words could lie mid-build on their own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** The author's own empty copy, written into the prop the way a screen writes it. */
const authorsOwn = { $element: true, component: "Text", props: { text: "Nothing here yet" } };

/** One surface holding every empty-state return path the slice touches: the
 *  default copy, the slot on the `<div>` branch (CardList, and Timeline with
 *  it), and the slot on the shared ChartEmpty branch (all three charts). */
const emptyApp = (streaming: boolean) => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  streaming,
  nodes: [
    { id: "root", component: "Stack", children: ["table", "cards", "chart"] },
    { id: "table", component: "DataTable", props: { rows: [], columns: [{ key: "amount" }] } },
    { id: "cards", component: "CardList", props: { items: [], titleField: "name", empty: authorsOwn } },
    { id: "chart", component: "LineChart", props: { data: [], xKey: "day", series: [{ key: "spend" }], empty: authorsOwn } },
  ],
}) as WalkTree & { formatVersion: typeof VENDO_TREE_FORMAT };

describe("Kit empty states under a forming surface", () => {
  it("reads as loading mid-build and as the real empty state once the build settles", () => {
    const { rerender } = render(<TreeView tree={emptyApp(true)} components={{}} onAction={ok} />);
    expect(screen.queryByText("No data")).toBeNull();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(document.querySelectorAll("[data-skeleton]")).toHaveLength(3);

    rerender(<TreeView tree={emptyApp(false)} components={{}} onAction={ok} />);
    expect(screen.getByText("No data")).toBeTruthy();
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(2);
    expect(document.querySelectorAll("[data-skeleton]")).toHaveLength(0);
  });
});

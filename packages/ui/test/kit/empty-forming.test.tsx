// @vitest-environment jsdom
/**
 * A table with no rows YET is not a table with no rows. While the build is in
 * flight the empty copy is a lie, so it holds the same skeleton the rest of the
 * forming surface uses — and the moment the paint settles, a genuinely empty
 * table says so again.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const emptyTable = (streaming: boolean) => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  streaming,
  nodes: [{ id: "root", component: "DataTable", props: { rows: [], columns: [{ key: "amount" }] } }],
}) as WalkTree & { formatVersion: typeof VENDO_TREE_FORMAT };

describe("Kit empty states under a forming surface", () => {
  it("reads as loading mid-build and as the real empty state once the build settles", () => {
    const { rerender } = render(<TreeView tree={emptyTable(true)} components={{}} onAction={ok} />);
    expect(screen.queryByText("No data")).toBeNull();
    expect(document.querySelector("[data-skeleton]")).not.toBeNull();

    rerender(<TreeView tree={emptyTable(false)} components={{}} onAction={ok} />);
    expect(screen.getByText("No data")).toBeTruthy();
    expect(document.querySelector("[data-skeleton]")).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The per-row action, graded at the SEAM the feature actually spans: the model
 * writes a `rowAction` in the wire, the REAL compiler compiles it, the REAL
 * renderer renders it, and a real click has to reach `onAction` carrying THAT
 * row's id. Nothing here stubs either side — the previous shape (a Form over a
 * Select) passed every unit test and still sent the host `{}`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { compileWire } from "@vendoai/apps/contract";
import { PayloadView } from "../../src/tree/index.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { DataTable } from "../../src/kit/data/data-table.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const transfers = {
  data: [
    { id: "tr_1", to: "Alex Rivera", amount: 25000, status: "pending" },
    { id: "tr_2", to: "Jordan Avery", amount: 6000, status: "pending" },
    { id: "tr_3", to: "Mission St", amount: 285000, status: "completed" },
  ],
};

/** One <DataTable> whose rowAction cancels the row it sits on. */
const tableWire = (extra: string) =>
  `<App name="Transfers"><Query id="transfers" tool="list_transfers"/><DataTable ${extra}`
  + ' rowAction={{tool:"cancel_transfer",label:"Cancel",args:["id"],variant:"danger",'
  + 'when:{field:"status",equals:"pending"}}}/></App>';

const mount = (wire: string, onAction: (req: { nodeId: string; action: string; payload?: Json }) => Promise<ToolOutcome>) => {
  const compiled = compileWire(wire);
  expect(compiled.complete).toBe(true);
  render(
    <PayloadView
      payload={compiled.tree as unknown as UIPayload}
      components={{}}
      data={{ transfers }}
      onAction={onAction}
    />,
  );
  return compiled;
};

describe("DataTable rowAction — the wire → renderer → host seam", () => {
  it("survives the compiler as an object prop, not a zero-argument {$action}", () => {
    const compiled = compileWire(tableWire('rows={transfers.data} columns={[{key:"to"}]}'));
    const node = compiled.tree.nodes.find((entry) => entry.component === "DataTable");
    expect(node?.props?.rowAction).toEqual({
      tool: "cancel_transfer",
      label: "Cancel",
      args: ["id"],
      variant: "danger",
      when: { field: "status", equals: "pending" },
    });
  });

  it("presses one row's control and calls the tool with THAT row's id", async () => {
    const onAction = vi.fn(ok);
    mount(tableWire('rows={transfers.data} columns={[{key:"to"},{key:"status"}]}'), onAction);

    const buttons = screen.getAllByRole("button", { name: "Cancel" });
    // Only the two pending rows carry the control — `when` skipped the third.
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "cancel_transfer",
      payload: { id: "tr_2" },
    })));

    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "cancel_transfer",
      payload: { id: "tr_1" },
    })));
  });

  it("adds no column when the query returned no rows", () => {
    const onAction = vi.fn(ok);
    render(
      <PayloadView
        payload={compileWire(tableWire('rows={transfers.data} columns={[{key:"to"}]} emptyState="No transfers"'))
          .tree as unknown as UIPayload}
        components={{}}
        data={{ transfers: { data: [] } }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("No transfers")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders nothing pressable outside the tree walk, where there is no dispatcher", () => {
    render(
      <DataTable
        rows={transfers.data}
        columns={[{ key: "to" }]}
        rowAction={{ tool: "cancel_transfer", label: "Cancel" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("CardList itemAction", () => {
  it("carries each card's own id to the host", async () => {
    const onAction = vi.fn(ok);
    const compiled = compileWire(
      '<App name="Transfers"><Query id="transfers" tool="list_transfers"/>'
      + '<CardList items={transfers.data} titleField="to"'
      + ' itemAction={{tool:"cancel_transfer",label:"Cancel",args:["id"]}}/></App>',
    );
    render(
      <PayloadView
        payload={compiled.tree as unknown as UIPayload}
        components={{}}
        data={{ transfers }}
        onAction={onAction}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Cancel" });
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[2]!);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "cancel_transfer",
      payload: { id: "tr_3" },
    })));
  });

  it("renders no control outside the tree walk", () => {
    render(<CardList items={transfers.data} titleField="to" itemAction={{ tool: "x", label: "Cancel" }} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

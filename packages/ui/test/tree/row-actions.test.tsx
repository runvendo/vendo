// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { compileWire } from "@vendoai/apps/contract";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

/** The seam: markup the WRITER could write, compiled by the real wire compiler,
 *  rendered by the real renderer, pressed in a real DOM. Nothing here mocks the
 *  other side — a per-row control that compiles but fires nothing, or fires
 *  without the row it sits on, fails here. */
const WIRE = `<App name="Transfers">
  <Query id="transfers" tool="maple_transfers_list"/>
  <DataTable rows={transfers} columns={[{key:"payee"},{key:"status"}]}
    rowActions={[{label:"Cancel",tool:"maple_transfer_cancel",args:{id:"$row.id"},variant:"danger",when:{status:"pending"}}]}/>
</App>`;

const DATA: Record<string, Json> = {
  transfers: [
    { id: "tr_1", payee: "Rent", status: "pending" },
    { id: "tr_2", payee: "Gym", status: "completed" },
  ],
};

const compiled = () => {
  const result = compileWire(WIRE);
  // The compiler kept the prop (an unknown attribute form would have dropped it).
  const table = result.tree.nodes.find((node) => node.component === "DataTable");
  expect(Array.isArray(table?.props?.rowActions)).toBe(true);
  return result.tree as unknown as UIPayload;
};

describe("per-row controls on DataTable", () => {
  it("gives only the rows `when` admits a control, and fires that row's id", async () => {
    const calls: Array<{ action: string; payload?: Json }> = [];
    const onAction = async (request: { action: string; payload?: Json }): Promise<ToolOutcome> => {
      calls.push(request);
      return { status: "ok", output: null };
    };

    render(<PayloadView payload={compiled()} components={{}} data={DATA} onAction={onAction} />);

    // Two rows, one pending: exactly one control, and it is a Kit Button on the
    // theme's danger token — not a hand-rolled island button.
    const controls = screen.getAllByRole("button", { name: "Cancel" });
    expect(controls).toHaveLength(1);
    expect(controls[0]!.getAttribute("data-kit")).toBe("Button");
    expect(controls[0]!.getAttribute("data-variant")).toBe("danger");

    fireEvent.click(controls[0]!);
    // The press carries the row it sits on — a call without `tr_1` is the
    // "targets a fixed row by position" failure this prop exists to remove.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual([{ nodeId: expect.any(String), action: "maple_transfer_cancel", payload: { id: "tr_1" } }]);
  });
});

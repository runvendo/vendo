// @vitest-environment jsdom
/**
 * The row-action seam, end to end with no stub on either side: the REAL wire
 * compiler writes the prop and the REAL renderer presses it. An `on*` action
 * carries no arguments, so a mutation whose input schema requires an id
 * (`cancel_transfer{id}`) can only be wired on the row that holds the id —
 * this is the proof that the row's field arrives as the tool's argument.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ToolOutcome, UIPayload } from "@vendoai/core";
import { compileWire } from "@vendoai/apps/contract";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const payloadFor = (wire: string): UIPayload => compileWire(wire).tree as unknown as UIPayload;

const ROWS = '[{id:"t_1",payee:"Ada"},{id:"t_2",payee:"Grace"}]';

describe("rowAction — the one action that carries arguments", () => {
  it("presses a row's own control and calls the tool with that row's field", () => {
    const onAction = vi.fn(ok);
    render(
      <PayloadView
        payload={payloadFor(
          `<App name="Transfers"><DataTable rows={${ROWS}} columns={[{key:"payee"}]}`
          + ` rowAction={{label:"Cancel",tool:"cancel_transfer",args:{id:"id"},variant:"danger"}}/></App>`,
        )}
        components={{}}
        onAction={onAction}
      />,
    );

    const controls = screen.getAllByRole("button", { name: "Cancel" });
    expect(controls).toHaveLength(2);
    fireEvent.click(controls[1]!);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({ action: "cancel_transfer", payload: { id: "t_2" } });
  });

  it("keeps an argless action argless — a Form submit passes its EVENT, never a payload", () => {
    const onAction = vi.fn(ok);
    render(
      <PayloadView
        payload={payloadFor('<App name="Transfers"><Form onSubmit="cancel_transfer" submitLabel="Cancel"/></App>')}
        components={{}}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({ action: "cancel_transfer" });
    expect(onAction.mock.calls[0]![0]).not.toHaveProperty("payload");
  });
});

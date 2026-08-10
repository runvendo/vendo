// @vitest-environment jsdom
/**
 * The seam: the COMPILER decides which actions must be confirmed (from the
 * host's own risk grading) and the RENDERER is what stands the confirmation in
 * front of the call. Neither side is stubbed here — the wire goes through the
 * real `compileWire` with the real production option, and the payload it emits
 * is rendered by the real `PayloadView`. A test that hand-wrote
 * `confirmActions` would let the two halves disagree forever.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { compileWire } from "@vendoai/apps/contract";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

/** Maple's own grading: `cancel_transfer` takes arguments and declares no data,
 *  so the host graded it a write; `list_transfers` answers rows and is a read. */
const WRITE_TOOLS = ["cancel_transfer"];

const wire = `<App name="Transfers">
  <Button label="Cancel Alex Rivera" onClick={{action: "cancel_transfer", payload: {id: "tr_1"}}} variant="danger"/>
  <Button label="Refresh" onClick="list_transfers"/>
</App>`;

const payloadOf = (writeTools: readonly string[]): UIPayload =>
  compileWire(wire, { writeTools }).tree as unknown as UIPayload;

const recorder = (): { calls: Array<{ action: string; payload?: Json }>; onAction: (req: { nodeId: string; action: string; payload?: Json }) => Promise<ToolOutcome> } => {
  const calls: Array<{ action: string; payload?: Json }> = [];
  return {
    calls,
    onAction: async ({ action, payload }) => {
      calls.push({ action, ...(payload === undefined ? {} : { payload }) });
      return { status: "ok", output: null };
    },
  };
};

const dialog = (): HTMLElement | null => document.querySelector("[role=dialog]");

describe("a destructive action confirms by construction", () => {
  it("the compiler stamps only the write-graded tool the document names", () => {
    const stamped = compileWire(wire, { writeTools: WRITE_TOOLS }).tree;
    expect(stamped.confirmActions).toEqual(["cancel_transfer"]);
    // No grading passed (a bare compile, or a host with only read tools): nothing
    // is stamped, so the field stays absent rather than empty.
    expect(compileWire(wire).tree.confirmActions).toBeUndefined();
    expect(compileWire(wire, { writeTools: ["delete_account"] }).tree.confirmActions).toBeUndefined();
  });

  it("holds the call behind a dialog and sends it — with its own arguments — only after the confirm", async () => {
    const host = recorder();
    render(<PayloadView payload={payloadOf(WRITE_TOOLS)} components={{}} onAction={host.onAction} />);

    fireEvent.click(screen.getByText("Cancel Alex Rivera"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(host.calls).toEqual([]);

    // The probe's rule, and a person's: the destructive answer is the LAST
    // control in the confirmation, and everything before it is a way out.
    const controls = [...dialog()!.querySelectorAll("button:not([disabled])")];
    expect(controls.length).toBeGreaterThan(1);
    fireEvent.click(controls.at(-1)!);

    await waitFor(() => expect(host.calls).toEqual([{ action: "cancel_transfer", payload: { id: "tr_1" } }]));
    expect(dialog()).toBeNull();
  });

  it("sends nothing when the confirmation is declined, and says nothing went wrong", async () => {
    const host = recorder();
    render(<PayloadView payload={payloadOf(WRITE_TOOLS)} components={{}} onAction={host.onAction} />);

    fireEvent.click(screen.getByText("Cancel Alex Rivera"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByText("Keep it"));

    await waitFor(() => expect(dialog()).toBeNull());
    expect(host.calls).toEqual([]);
    // Backing out is an answer, not a failure: no contained error notice.
    expect(document.querySelector('[data-vendo-notice="error"]')).toBeNull();
    expect(document.querySelector('[data-vendo-notice="blocked"]')).toBeNull();
  });

  it("leaves a read action alone", async () => {
    const host = recorder();
    render(<PayloadView payload={payloadOf(WRITE_TOOLS)} components={{}} onAction={host.onAction} />);

    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(host.calls).toEqual([{ action: "list_transfers" }]));
    expect(dialog()).toBeNull();
  });
});

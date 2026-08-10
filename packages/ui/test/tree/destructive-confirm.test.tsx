// @vitest-environment jsdom
/**
 * A control bound to a MUTATING tool confirms before it fires — by construction.
 *
 * The seam, end to end, with nothing stubbed on either side: the real wire
 * compiler stamps the host's graded write tools onto the tree, and the real
 * renderer holds the call until the person answers. A test that hand-wrote the
 * payload would only prove the renderer reads a field the compiler might never
 * write, which is exactly the class of dead feature this repo ships four times
 * when the producer and the consumer each mock the other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ToolOutcome, UIPayload } from "@vendoai/core";
import { compileWire } from "@vendoai/apps/contract";
import { PayloadView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The host's own grading, as `wireCompileOptionsFor` hands it to the compiler. */
const WRITE_TOOLS = ["cancel_transfer"];

const payloadFor = (wire: string): UIPayload =>
  compileWire(wire, { writeTools: WRITE_TOOLS }).tree as unknown as UIPayload;

const CANCEL_ROW = `<App name="Pending transfers">
  <Button label="Cancel" onClick={{ action: "cancel_transfer", payload: { id: "tr_1" } }}/>
</App>`;

const REFRESH_ROW = `<App name="Pending transfers">
  <Button label="Refresh" onClick={{ action: "list_transfers", payload: { limit: 5 } }}/>
</App>`;

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

describe("a mutating action confirms before it is sent", () => {
  it("stamps the host's write tools onto the compiled tree", () => {
    expect((payloadFor(CANCEL_ROW) as unknown as { writeTools?: unknown }).writeTools).toEqual(WRITE_TOOLS);
  });

  it("asks first, then sends the row's own arguments once confirmed", async () => {
    const onAction = vi.fn(ok);
    render(<PayloadView payload={payloadFor(CANCEL_ROW)} components={{}} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("dialog");
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "cancel_transfer", payload: { id: "tr_1" } }),
      );
    });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("drops the call when the person keeps things as they are, and says nothing about it", async () => {
    const onAction = vi.fn(ok);
    render(<PayloadView payload={payloadFor(CANCEL_ROW)} components={{}} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep as is" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onAction).not.toHaveBeenCalled();
    // Declining is a choice, not a failure the screen has to report back.
    expect(screen.queryByText(/action blocked/i)).toBeNull();
  });

  it("leaves a read straight through — no tool the host graded read is gated", async () => {
    const onAction = vi.fn(ok);
    render(<PayloadView payload={payloadFor(REFRESH_ROW)} components={{}} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "list_transfers", payload: { limit: 5 } }),
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

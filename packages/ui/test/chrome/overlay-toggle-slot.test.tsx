// @vitest-environment jsdom
import { useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type OpenSurface, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot } from "../../src/chrome/index.js";
import { openVendoConversation } from "../../src/chrome/overlay-registry.js";
import { createWireServer } from "../wire-server.js";

describe("the conversation opener and VendoSlot exports", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  it("opens the conversation surface with the composer focused; Escape restores focus", async () => {
    render(
      <VendoProvider client={client}>
        <button type="button">Host opener</button>
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    const opener = screen.getByRole("button", { name: "Host opener" });
    opener.focus();
    act(() => { openVendoConversation(); });
    // One surface: the conversation overlay, composer focused, no combobox.
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(composer));

    // Escape closes the surface and restores focus to the invoker.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Vendo assistant" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    // `toggle` is the seam a host's own keyboard shortcut uses: open, then a
    // second call (even with the composer focused) closes.
    act(() => { openVendoConversation({ toggle: true }); });
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const reopenedComposer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(reopenedComposer));
    act(() => { openVendoConversation({ toggle: true }); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  // A toggle that lands in the window between the overlay's hide-commit and the
  // registry opener's re-register used to reach a closure holding a STALE `open`
  // (still true), so the toggle "closed" an already-closed overlay and the
  // dialog never came back — toggle right after the surface hides and the
  // assistant stays dark.
  //
  // The window is real in production: the browser can dispatch a keydown after
  // React commits the hide but before it flushes the (passive) re-register,
  // which the scheduler defers to a later macrotask. A layout effect is that
  // window made deterministic — it runs during the SAME commit, after render
  // (so the opener's `openRef` already reads false) but before any passive
  // effect (so the opener has not re-registered). `Racer` fires the racing
  // toggle there on the hide transition. With the ref-read guard the toggle
  // reopens; revert it to the stale `open` read and this goes red every run.
  function Racer({ open }: { open: boolean }) {
    const previous = useRef(open);
    useLayoutEffect(() => {
      if (previous.current && !open) openVendoConversation({ toggle: true });
      previous.current = open;
    }, [open]);
    return null;
  }

  it("reopens on a toggle racing its own hide — no stale-closure toggle swallows it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <VendoProvider client={client}>
          <VendoOverlay launcher="none" onOpenChange={setOpen} />
          <Racer open={open} />
        </VendoProvider>
      );
    }
    render(<Harness />);
    act(() => { openVendoConversation({ toggle: true }); });
    await screen.findByRole("dialog", { name: "Vendo assistant" });

    // Close from a host affordance; the Racer's layout effect fires the racing
    // ⌘K in the hide's own commit, before the opener re-registers.
    await act(async () => {
      openVendoConversation({ close: true });
    });

    // The racing toggle must have re-opened the surface, not swallowed itself.
    await screen.findByRole("dialog", { name: "Vendo assistant" });
  });

  it("leaves children untouched without an app and renders a wire app inline with one", async () => {
    const view = render(<VendoProvider client={client}><VendoSlot id="hero"><span>Original hero</span></VendoSlot></VendoProvider>);
    expect(screen.getByText("Original hero").parentElement).toBe(view.container);
    view.rerender(<VendoProvider client={client}><VendoSlot id="hero" appId="app_1"><span>Original hero</span></VendoSlot></VendoProvider>);
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });

  it("falls back to original children when the mounted surface throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {} as OpenSurface;
    Object.defineProperty(broken, "kind", { get: () => { throw new Error("mount failed"); } });
    const throwingClient: VendoClient = {
      ...client,
      apps: { ...client.apps, open: async () => broken },
    };
    render(<VendoProvider client={throwingClient}><VendoSlot id="hero" appId="app_1"><span>Safe original</span></VendoSlot></VendoProvider>);
    expect(await screen.findByText("Safe original")).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type OpenSurface, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPage, VendoPalette, VendoSlot } from "../../src/chrome/index.js";
import { getConversationCommands, openVendoConversation } from "../../src/chrome/overlay-registry.js";
import { createWireServer } from "../wire-server.js";

describe("VendoPage, VendoPalette, and VendoSlot exports", () => {
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

  // Roving tabindex with APG MANUAL activation: arrows move focus, Enter/Space
  // ⚠️ TEST EDIT — this asserted MANUAL activation ("New chat" was a tab, and
  // arrowing onto it ACTED, discarding the open conversation and its draft —
  // H18). The act is a plain button outside the tablist now, so the arrows
  // cannot reach it and the remaining VIEW tabs select as focus moves, per APG.
  it("uses roving tabs, swaps panels, and lists and opens fixture apps", async () => {
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    const apps = screen.getByRole("tab", { name: "Apps" });
    apps.focus();
    fireEvent.keyDown(apps, { key: "ArrowRight" });
    const automations = screen.getByRole("tab", { name: "Automations" });
    expect(document.activeElement).toBe(automations);
    expect(automations.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(apps);
    expect(apps.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Invoices")).toBeTruthy();
    expect(screen.getByText("Invoice watcher")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Invoices" }));
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Automations" }));
    expect(await screen.findByRole("heading", { name: "Automations" })).toBeTruthy();
    // Activity moved under the rail's quiet ··· row (redesign §10: the two
    // named doors are Apps and Automations; receipts are one gesture away).
    fireEvent.click(screen.getByRole("button", { name: "More sections" }));
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
  });

  it("routes Ctrl+K to the conversation surface; command chips reach onCommand; Escape restores focus", async () => {
    const onCommand = vi.fn();
    render(
      <VendoProvider client={client}>
        <button type="button">Palette opener</button>
        <VendoPalette onCommand={onCommand} />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    await waitFor(() => expect(wire.requests.some(request => request.path === "/apps")).toBe(true));
    const opener = screen.getByRole("button", { name: "Palette opener" });
    opener.focus();
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    // One surface: the conversation overlay, composer focused, no combobox.
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(composer));
    // The palette's commands (built-ins + wire apps) publish through the
    // overlay registry (chip strip removed 2026-07-23); a host router
    // consumes them via select().
    await waitFor(() => {
      const set = getConversationCommands();
      expect(set?.commands.some(command => command.kind === "open-app")).toBe(true);
    });
    const set = getConversationCommands()!;
    set.select(set.commands.find(command => command.kind === "open-app")!);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "open-app", appId: "app_1" }));
    // Host-routed select closes the surface (close-on-select) — reopen for
    // the Escape/focus assertions below.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    opener.focus();
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    // Escape closes the surface and restores focus to the invoker.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Vendo assistant" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    // ⌘K toggles: open, then a second press (even from the composer) closes.
    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const reopenedComposer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(reopenedComposer));
    fireEvent.keyDown(reopenedComposer, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  // A ⌘K that lands in the window between the overlay's hide-commit and the
  // registry opener's re-register used to reach a closure holding a STALE `open`
  // (still true), so the toggle "closed" an already-closed overlay and the
  // dialog never came back — hit ⌘K right after the surface hides and the
  // assistant stays dark.
  //
  // The window is real in production: the browser can dispatch a keydown after
  // React commits the hide but before it flushes the (passive) re-register,
  // which the scheduler defers to a later macrotask. A layout effect is that
  // window made deterministic — it runs during the SAME commit, after render
  // (so the opener's `openRef` already reads false) but before any passive
  // effect (so the opener has not re-registered). `Racer` fires the racing ⌘K
  // there on the hide transition. With the ref-read guard the toggle reopens;
  // revert it to the stale `open` read and this goes red every run.
  function Racer({ open }: { open: boolean }) {
    const previous = useRef(open);
    useLayoutEffect(() => {
      if (previous.current && !open) fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
      previous.current = open;
    }, [open]);
    return null;
  }

  it("reopens on a ⌘K racing its own hide — no stale-closure toggle swallows it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <VendoProvider client={client}>
          <button type="button">Palette opener</button>
          <VendoPalette />
          <VendoOverlay launcher="none" onOpenChange={setOpen} />
          <Racer open={open} />
        </VendoProvider>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(wire.requests.some(request => request.path === "/apps")).toBe(true));
    const opener = screen.getByRole("button", { name: "Palette opener" });
    opener.focus();
    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    await screen.findByRole("dialog", { name: "Vendo assistant" });

    // Close from a host affordance; the Racer's layout effect fires the racing
    // ⌘K in the hide's own commit, before the opener re-registers.
    await act(async () => {
      openVendoConversation({ close: true });
    });

    // The racing toggle must have re-opened the surface, not swallowed itself.
    await screen.findByRole("dialog", { name: "Vendo assistant" });
  });

  it("contains app mutation wire errors in an alert without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    await screen.findByText("Invoices");
    wire.state.failures.push({
      method: "POST",
      path: "/apps",
      code: "sandbox-unavailable",
      message: "App creation unavailable",
      status: 501,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Describe a new app" }), { target: { value: "Build a report" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // The failure is CONTAINED (an alert, no unhandled rejection) and it is
    // contained in the CONSUMER's voice: the page used to render the wire's own
    // sentence verbatim, which is how "app not found: app_1" and a sentence
    // naming VENDO_API_KEY reached whoever was using the app (design §3). The
    // developer sentence keeps its home in the server's error and the console.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("App creation unavailable");
    expect(alert.textContent).toMatch(/didn’t go through/i);
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
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

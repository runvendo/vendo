// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPalette } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

// ENG-222 — the command palette's keybinding must be a host-collision-safe
// singleton: one shared listener no matter how many palettes mount (no
// double-toggle), a configurable/disable-able chord, and it must never steal a
// keystroke the host meant for its own focused input.
describe("VendoPalette singleton, host-collision-safe keybinding", () => {
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

  it("delivers the shared keybinding exactly once even when two palettes mount", async () => {
    render(
      <VendoProvider client={client}>
        <button type="button">Opener</button>
        <VendoPalette />
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    screen.getByRole("button", { name: "Opener" }).focus();
    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    // The keybinding TOGGLES the one-surface overlay: double delivery (the
    // pre-ENG-222 bug) would toggle twice and leave it closed. Exactly one
    // delivery leaves exactly one open dialog.
    const dialogs = await screen.findAllByRole("dialog", { name: "Vendo assistant" });
    expect(dialogs).toHaveLength(1);
  });

  it("does not hijack the keybinding while a host input is focused", async () => {
    render(
      <VendoProvider client={client}>
        <input aria-label="Host search" />
        <VendoPalette />
      </VendoProvider>,
    );
    const hostInput = screen.getByRole("textbox", { name: "Host search" });
    hostInput.focus();
    fireEvent.keyDown(hostInput, { key: "k", metaKey: true });
    // The host keeps its own ⌘K inside its own field.
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    expect(document.activeElement).toBe(hostInput);
  });

  it("honors a configurable chord and can be disabled entirely", async () => {
    const { rerender } = render(
      <VendoProvider client={client}>
        <button type="button">Opener</button>
        <VendoPalette hotkey={{ key: "j", meta: true }} />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    screen.getByRole("button", { name: "Opener" }).focus();
    // The default ⌘K no longer opens a surface bound to ⌘J.
    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    // The configured chord opens it.
    fireEvent.keyDown(globalThis, { key: "j", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Vendo assistant" });
    expect(dialog).toBeTruthy();
    // Close it before disabling (disabling stops the keybinding, it doesn't
    // close an already-open surface).
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());

    // Disabling the keybinding leaves no keyboard opener at all.
    rerender(
      <VendoProvider client={client}>
        <button type="button">Opener</button>
        <VendoPalette hotkey={false} />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    fireEvent.keyDown(globalThis, { key: "j", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
  });
});

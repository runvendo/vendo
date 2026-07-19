// @vitest-environment jsdom
// One-surface ⌘K (ui-lane-entry pick P-C): VendoPalette is headless — the
// keybinding opens the conversation overlay, and the palette's commands render
// as the overlay's chip strip above the composer. The self-sufficient default
// (no host onCommand router) still opens conversations through the overlay
// registry, and unroutable commands still hint in dev.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPalette } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import { createWireServer } from "../wire-server.js";

describe("VendoPalette self-sufficient defaults (one-surface)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    // These tests assert the RETURNING-user landing ("What can I help you
    // build?"); a first-ever open would show the one-time greeting-as-tutorial
    // instead (discoverability §6), so mark it already seen.
    markSeen("greeting");
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await wire.close();
  });

  const pressHotkey = () => fireEvent.keyDown(window, { key: "k", metaKey: true });

  it("⌘K opens the conversation overlay — not a palette dialog", async () => {
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    pressHotkey();
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    // There is no separate command palette surface anymore.
    expect(screen.queryByRole("dialog", { name: "Vendo command palette" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // The empty landing greets, with the palette's commands as a chip strip.
    expect(screen.getByText("What can I help you build?")).toBeTruthy();
    const strip = await screen.findByRole("toolbar", { name: "Commands" });
    expect(within(strip).getByRole("button", { name: "New conversation" })).toBeTruthy();
    expect(within(strip).getByRole("button", { name: "Show activity" })).toBeTruthy();
  });

  it("'New conversation' chip starts a fresh thread through the overlay registry", async () => {
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    pressHotkey();
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const strip = await screen.findByRole("toolbar", { name: "Commands" });
    fireEvent.click(within(strip).getByRole("button", { name: "New conversation" }));
    // Still the one surface, resting on a fresh empty landing.
    expect(screen.getByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    expect(await screen.findByText("What can I help you build?")).toBeTruthy();
  });

  it("hints in dev (and stays a safe no-op) when no overlay is mounted", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<VendoProvider client={client}><VendoPalette /></VendoProvider>);
    pressHotkey();
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("VendoOverlay")));
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
  });

  it("hints in dev for commands that need a host router (show-activity)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    pressHotkey();
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    fireEvent.click(await screen.findByRole("button", { name: "Show activity" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("onCommand"));
  });

  it("defers entirely to a supplied onCommand handler", async () => {
    const onCommand = vi.fn();
    render(
      <VendoProvider client={client}>
        <VendoPalette onCommand={onCommand} />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    pressHotkey();
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const strip = await screen.findByRole("toolbar", { name: "Commands" });
    fireEvent.click(within(strip).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "new-conversation" })));
  });
});

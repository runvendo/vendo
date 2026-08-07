// @vitest-environment jsdom
// One-surface ⌘K (ui-lane-entry pick P-C, chip strip removed 2026-07-23):
// VendoPalette is headless — the keybinding opens the conversation overlay.
// The palette still PUBLISHES its command set through the overlay registry
// (hosts with an onCommand router consume it there), but the overlay no
// longer renders a built-in chip strip above the composer.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPalette } from "../../src/chrome/index.js";
import { getConversationCommands } from "../../src/chrome/overlay-registry.js";
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

  it("⌘K opens the conversation overlay — no palette dialog, no chip strip", async () => {
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
    // The empty landing greets — and stays chip-strip-free (2026-07-23).
    expect(screen.getByText("What can I help you build?")).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull();
  });

  it("still publishes the command set through the overlay registry", async () => {
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    await waitFor(() => expect(getConversationCommands()).not.toBeNull());
    const kinds = getConversationCommands()!.commands.map((command) => command.kind);
    expect(kinds).toContain("new-conversation");
    expect(kinds).toContain("show-activity");
  });

  it("registry select on 'new-conversation' starts a fresh thread through the overlay", async () => {
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    pressHotkey();
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const set = getConversationCommands()!;
    set.select(set.commands.find((command) => command.kind === "new-conversation")!);
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
    await waitFor(() => expect(getConversationCommands()).not.toBeNull());
    const set = getConversationCommands()!;
    set.select(set.commands.find((command) => command.kind === "show-activity")!);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("onCommand")));
  });

  it("defers entirely to a supplied onCommand handler and closes the surface first", async () => {
    const onCommand = vi.fn();
    render(
      <VendoProvider client={client}>
        <VendoPalette onCommand={onCommand} />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    pressHotkey();
    await screen.findByRole("dialog", { name: "Vendo assistant" });
    const set = getConversationCommands()!;
    set.select(set.commands.find((command) => command.kind === "new-conversation")!);
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "new-conversation" })));
    // Host-routed commands close the surface first (the old palette's
    // close-on-select) so host navigation never lands behind the modal.
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
  });

  it("collapses an empty launcher label to the accessible blob-only orb", () => {
    render(
      <VendoProvider client={client}>
        <VendoOverlay launcher={{ label: "" }} />
      </VendoProvider>,
    );
    const orb = screen.getByRole("button", { name: "AI agent" });
    expect(orb.hasAttribute("data-vendo-launcher-bare")).toBe(true);
  });
});

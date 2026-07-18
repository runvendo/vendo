// @vitest-environment jsdom
// Shelf Task 5 — palette demotion with a self-sufficient default: with no host
// onCommand router, conversation commands open the mounted overlay through the
// overlay registry instead of no-opping; unroutable commands hint in dev.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPalette } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("VendoPalette self-sufficient defaults", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await wire.close();
  });

  const openPalette = () => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    return screen.findByRole("combobox");
  };

  const pick = async (label: string) => {
    fireEvent.click(await screen.findByText(label));
  };

  it("opens the mounted overlay on 'New conversation' when no onCommand is supplied", async () => {
    render(
      <VendoProvider client={client}>
        <VendoPalette />
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    await openPalette();
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    await pick("New conversation");
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    // A fresh conversation: the empty landing greets.
    expect(screen.getByText("What can I help you build?")).toBeTruthy();
  });

  it("hints in dev (and stays a safe no-op) when no overlay is mounted", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<VendoProvider client={client}><VendoPalette /></VendoProvider>);
    await openPalette();
    await pick("New conversation");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("VendoOverlay"));
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
    await openPalette();
    await pick("Show activity");
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
    await openPalette();
    await pick("New conversation");
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "new-conversation" })));
    // The default must NOT also fire.
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
  });
});

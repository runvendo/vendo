// @vitest-environment jsdom
// Shelf Task 4 — the Slot `remix` flag: the hover Remix affordance on a slot's
// content, opening the conversation surface preloaded with a remix prompt via
// the overlay registry (the openVendoPalette pattern, generalized).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot } from "../../src/chrome/index.js";
import { openVendoOverlay } from "../../src/chrome/overlay-registry.js";
import { createWireServer } from "../wire-server.js";

describe("VendoSlot remix flag + overlay registry", () => {
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

  const HostHero = () => <span>Original hero</span>;

  it("renders the hover Remix affordance over the slot's original content", () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    expect(screen.getByText("Original hero")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remix/i })).toBeTruthy();
  });

  it("renders no affordance without the flag", () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero"><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    expect(screen.queryByRole("button", { name: /remix/i })).toBeNull();
  });

  it("opens the mounted overlay preloaded with the remix prompt and sends it", async () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix remixPrompt="Remix my hero card with deadlines"><HostHero /></VendoSlot>
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /remix/i }));
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    // The prompt rode into the thread and was sent as the opening turn.
    await waitFor(() => expect(screen.getByText("Remix my hero card with deadlines")).toBeTruthy());
    await waitFor(() => {
      const posts = wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
      expect(posts.length).toBe(1);
    });
  });

  it("derives a default prompt from the slot's registered component", async () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix><HostHero /></VendoSlot>
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /remix/i }));
    await waitFor(() => expect(screen.getByText(/remix/i, { selector: ".fl-usertext" })).toBeTruthy());
    expect(screen.getByText(/hero/i, { selector: ".fl-usertext" })).toBeTruthy();
  });

  it("warns in dev when remix is set but the slot has no registered component", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client}>
        <VendoSlot id="unregistered-slot" remix><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unregistered-slot"));
  });

  it("hints (and stays a safe no-op) when no overlay is mounted", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    expect(() => fireEvent.click(screen.getByRole("button", { name: /remix/i }))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("VendoOverlay"));
  });

  it("openVendoOverlay reports false with no overlay mounted (registry parity)", () => {
    expect(openVendoOverlay({ prompt: "anything" })).toBe(false);
  });
});

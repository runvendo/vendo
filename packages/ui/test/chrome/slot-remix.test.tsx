// @vitest-environment jsdom
// Shelf Task 4 — the Slot `remix` flag: the hover Remix affordance on a slot's
// content. Gesture-owned forking (2026-07-21): the empty-slot gesture executes
// the fork DETERMINISTICALLY through POST /apps/fork-pin (no model call, no
// conversation turn); a filled slot opens the composer prefilled instead, so
// the instruction rides an ordinary edit.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSlot } from "../../src/chrome/index.js";
import { openVendoConversation } from "../../src/chrome/overlay-registry.js";
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

  it("executes the empty-slot gesture as a deterministic wire fork — no model turn", async () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix><HostHero /></VendoSlot>
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /remix/i }));
    // The gesture rides POST /apps/fork-pin with the slot id — and nothing
    // reaches the conversation surface (the model lost the fork decision).
    await waitFor(() => {
      const forks = wire.requests.filter(r => r.method === "POST" && r.path === "/apps/fork-pin");
      expect(forks.length).toBe(1);
      expect(forks[0]?.body).toEqual({ slot: "hero" });
    });
    // The forked app mounts through slot discovery (pins carry the slot id).
    await waitFor(() => expect(screen.getByText("hero remix app surface")).toBeTruthy());
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads").length).toBe(0);
  });

  it("never mints a second fork before the first surfaces (discover={false} hosts)", async () => {
    // With discover={false} the parent manages appId on its own poll cadence,
    // so after the fast wire fork resolves the slot still LOOKS empty. The
    // affordance must latch until the fork surfaces — the wire fork is not
    // idempotent, and a second tap would mint a duplicate app.
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" remix discover={false}><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    const button = screen.getByRole("button", { name: /remix/i }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => {
      expect(wire.requests.filter(r => r.method === "POST" && r.path === "/apps/fork-pin").length).toBe(1);
    });
    // Let the fork promise resolve; the button must STAY latched (the slot
    // still has no appId), and further taps must not reach the wire.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/apps/fork-pin").length).toBe(1);
  });

  it("opens the composer PREFILLED (never sent) when the slot already holds an app", async () => {
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" appId="app_1" remix remixPrompt="Update my hero remix with deadlines"><HostHero /></VendoSlot>
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /remix/i }));
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
    // Prefilled in the composer, not sent: no thread turn, no wire fork.
    await waitFor(() => {
      const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(composer.value).toBe("Update my hero remix with deadlines");
    });
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads").length).toBe(0);
    expect(wire.requests.filter(r => r.method === "POST" && r.path.endsWith("fork-pin")).length).toBe(0);
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

  it("hints (and stays a safe no-op) when a filled slot's remix finds no overlay", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client} components={{ hero: HostHero }}>
        <VendoSlot id="hero" appId="app_1" remix><HostHero /></VendoSlot>
      </VendoProvider>,
    );
    expect(() => fireEvent.click(screen.getByRole("button", { name: /remix/i }))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("VendoOverlay"));
  });

  it("openVendoConversation reports false with no overlay mounted (registry parity)", () => {
    expect(openVendoConversation({ prompt: "anything" })).toBe(false);
  });
});

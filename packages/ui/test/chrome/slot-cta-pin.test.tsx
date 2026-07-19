// @vitest-environment jsdom
import type { UIPayload } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoPalette, VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** A minimal pinned generated view — a vendo-genui/v2 tree of a single Text
 *  primitive. This is the "pinned component" the slot mounts in place (08 §4). */
const pinPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "Pinned revenue card" } }],
} as UIPayload;

describe("VendoSlot empty-state CTA + pinned-component path (ENG-223)", () => {
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

  it("renders the empty-state CTA as a real, focusable button", () => {
    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);
    const cta = screen.getByRole("button", { name: /design a view/i });
    cta.focus();
    expect(document.activeElement).toBe(cta);
  });

  it("invokes onAuthor with the slot id when the CTA is activated", () => {
    const onAuthor = vi.fn();
    render(<VendoProvider client={client}><VendoSlot id="hero" onAuthor={onAuthor} /></VendoProvider>);
    fireEvent.click(screen.getByRole("button", { name: /design a view/i }));
    expect(onAuthor).toHaveBeenCalledWith("hero");
  });

  it("opens a mounted palette by default when the CTA has no onAuthor", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoPalette />
      </VendoProvider>,
    );
    await waitFor(() => expect(wire.requests.some(request => request.path === "/apps")).toBe(true));
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /design a view/i }));
    expect(await screen.findByRole("combobox")).toBeTruthy();
  });

  it("keeps the default CTA a safe no-op when no palette is mounted", () => {
    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);
    const cta = screen.getByRole("button", { name: /design a view/i });
    expect(() => fireEvent.click(cta)).not.toThrow();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("mounts a pinned component in the slot, in place of the host children", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" pin={{ payload: pinPayload }}><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Pinned revenue card")).toBeTruthy();
  });

  it("threads live pin data through, overriding the tree's embedded data model", async () => {
    const bound = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      data: { revenue: { label: "Stale embedded label" } },
      nodes: [{ id: "root", component: "Text", props: { text: { $path: "/revenue/label" } } }],
    } as UIPayload;
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" pin={{ payload: bound, data: { revenue: { label: "Live pinned revenue" } } }}>
          <span>Original hero</span>
        </VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Live pinned revenue")).toBeTruthy();
  });

  it("falls back to the host children when the pinned component throws on mount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {} as UIPayload;
    Object.defineProperty(broken, "formatVersion", {
      get() { throw new Error("pin mount exploded during render"); },
    });
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" pin={{ payload: broken }}><span>Safe original</span></VendoSlot>
      </VendoProvider>,
    );
    expect(await screen.findByText("Safe original")).toBeTruthy();
  });
});

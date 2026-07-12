// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type OpenSurface, type VendoClient } from "../../src/index.js";
import { VendoPage, VendoPalette, VendoSlot } from "../../src/chrome/index.js";
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

  it("uses roving automatic tabs, swaps panels, and lists and opens fixture apps", async () => {
    render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    const chat = screen.getByRole("tab", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    const apps = screen.getByRole("tab", { name: "Apps" });
    expect(document.activeElement).toBe(apps);
    expect(apps.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Invoices")).toBeTruthy();
    expect(screen.getByText("Invoice watcher")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Automations" }));
    expect(await screen.findByRole("heading", { name: "Automations" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
  });

  it("opens with Ctrl+K, filters, selects with arrows and Enter, and closes with Escape", async () => {
    const onCommand = vi.fn();
    render(<VendoProvider client={client}><VendoPalette onCommand={onCommand} /></VendoProvider>);
    await waitFor(() => expect(wire.requests.some(request => request.path === "/apps")).toBe(true));
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    const combobox = await screen.findByRole("combobox");
    expect(document.activeElement).toBe(combobox);
    fireEvent.change(combobox, { target: { value: "Invoices" } });
    expect(screen.getByRole("option", { name: "Open Invoices" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Show activity" })).toBeNull();
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "open-app", appId: "app_1" }));
    expect(screen.queryByRole("dialog", { name: "Vendo command palette" })).toBeNull();

    fireEvent.keyDown(globalThis, { key: "k", metaKey: true });
    const reopened = await screen.findByRole("combobox");
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Vendo command palette" })).toBeNull();
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

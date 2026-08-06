// @vitest-environment jsdom
// "Add to…" — the placement write from a surface that is NOT the host's page.
// A BYO chat page renders a generated app inline; the app belongs on the
// dashboard, and until now the only path there was a host-built pin control.
// Destinations come from slot-notes (a mounted VendoSlot is the only thing that
// knows a slot exists) and the write is awaited, so "Added" is a fact.
import type { VendoAppRef } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoAppEmbed, VendoProvider, createVendoClient, noteSlot, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const ready: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices", status: "ready" };

describe("the Add to… picker", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const embed = () => render(
    <VendoProvider client={client}><VendoAppEmbed refValue={ready} /></VendoProvider>,
  );

  it("offers nothing when this origin has never mounted a slot", async () => {
    embed();
    await screen.findByText("Invoices app surface");
    expect(screen.queryByRole("button", { name: /Add to/ })).toBeNull();
  });

  it("lists the slots this origin has seen", async () => {
    noteSlot({ id: "hero", label: "Hero" });
    noteSlot({ id: "sidebar", label: "Sidebar" });
    embed();
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    expect(screen.getByRole("menuitem", { name: "Hero" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sidebar" })).toBeTruthy();
  });

  it("writes the placement over the wire and says where it landed", async () => {
    noteSlot({ id: "hero", label: "Hero" });
    embed();
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hero" }));
    await waitFor(() => expect(
      wire.state.placements.find(row => row.slot === "hero")?.appId,
    ).toBe("app_1"));
    expect(await screen.findByRole("button", { name: /Added to Hero/ })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("announces the placement so a slot on the page fills without waiting for its poll", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
        <VendoAppEmbed refValue={ready} />
      </VendoProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hero" }));
    // The slot re-reads on the announcement, not on its 5s poll floor.
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });

  it("keeps the menu open with one honest line when the write does not go through", async () => {
    noteSlot({ id: "hero", label: "Hero" });
    vi.spyOn(client.apps, "place").mockRejectedValue(new Error("wire down"));
    embed();
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hero" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("menu")).toBeTruthy();
    // Nothing code-shaped from the wire's sentence reaches the page.
    expect(document.body.textContent).not.toContain("wire down");
  });

  it("closes on Escape", async () => {
    noteSlot({ id: "hero", label: "Hero" });
    embed();
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays out of the bar while the build is still streaming", async () => {
    noteSlot({ id: "hero", label: "Hero" });
    const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_never", title: "Weather board", status: "building" };
    render(<VendoProvider client={client}><VendoAppEmbed refValue={building} /></VendoProvider>);
    await screen.findByText(/Building/);
    expect(screen.queryByRole("button", { name: /Add to/ })).toBeNull();
  });
});

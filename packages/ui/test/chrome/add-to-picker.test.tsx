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
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

// The envelope's status is ALWAYS "building" — it never means done (core's
// vendoAppRefSchema). Readiness is the wire's answer: app_1 is servable, so the
// embed resolves its surface and the bar flips to the app's name.
const ready: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices", status: "building" };

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

/**
 * THE SEAM, end to end, with nothing stubbed on either side.
 *
 * The picker shipped reachable only from `VendoAppEmbed` — a component no host
 * in this repo mounts — so it passed its own suite while being dead in the
 * product: every real host renders its conversation through the overlay's
 * thread, and the thread's card offered one fixed pin. These cases walk the
 * whole chain the way a person does: REAL `VendoSlot`s note themselves into
 * slot-notes (the producer), the REAL in-thread card reads them (the consumer),
 * and the pick goes client → wire → placement row, which the slot on the page
 * then reads back.
 *
 * The host wiring mirrors demo-bank exactly: `pinSlot` is the Home hero, and the
 * destination proven here is the OTHER one — the pick has to be able to beat the
 * default, or the picker is decoration.
 */
describe("placing a generated view from the conversation the user is actually in", () => {
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

  /** The shape the stream emits for a finished build (`data-vendo-view`). */
  function view(appId: string) {
    return {
      type: "data-vendo-view",
      data: {
        appId,
        payload: {
          formatVersion: "vendo-genui/v2",
          name: "Spending board",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { text: "Spending board body" } }],
        },
      },
    } as unknown as Parameters<typeof ThreadPart>[0]["part"];
  }

  /** A host page carrying its own slots, with the conversation open over it —
   *  demo-bank's shape. Nothing here calls `noteSlot`: the slots do. */
  function host(appId: string, slots: string[]) {
    return render(
      <VendoProvider client={client} pinSlot="home-hero">
        {slots.map(id => <VendoSlot key={id} id={id} />)}
        <ThreadPart part={view(appId)} partKey="p0" role="assistant" restored={false} />
      </VendoProvider>,
    );
  }

  it("offers every slot the host has mounted, named the way the page names them", async () => {
    host("app_1", ["home-hero", "insights-custom-view"]);
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    expect(screen.getByRole("menuitem", { name: "Home hero" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Insights custom view" })).toBeTruthy();
  });

  it("puts the view in the slot the person picked — not the host's default — and the slot reads it back", async () => {
    host("app_1", ["home-hero", "insights-custom-view"]);
    fireEvent.click(await screen.findByRole("button", { name: /Add to/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Insights custom view" }));

    // The row on the real wire, under the picked slot and no other.
    await waitFor(() => expect(wire.state.placements).toEqual([{ slot: "insights-custom-view", appId: "app_1" }]));
    expect(await screen.findByRole("button", { name: /Added to Insights custom view/ })).toBeTruthy();
    // And the real slot on the page, reading that row back over the same wire.
    const landed = await screen.findByText("Invoices app surface");
    expect(landed.closest("[data-vendo-slot]")?.getAttribute("data-vendo-slot")).toBe("insights-custom-view");
  });

  it("keeps the one-click pin when the origin knows a single destination — a menu of one is not a choice", async () => {
    host("app_2", ["home-hero"]);
    expect(await screen.findByRole("button", { name: "Pin to dashboard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add to/ })).toBeNull();
  });
});

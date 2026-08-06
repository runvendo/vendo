// @vitest-environment jsdom
// A mounted slot is the ONLY thing that knows a slot exists (slot-notes.ts), so
// every VendoSlot says so — in every state, including the one where it renders
// the host's own markup untouched.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, knownSlots, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("a mounted VendoSlot notes itself", () => {
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

  it("notes the slot with a human label derived from its id", () => {
    render(<VendoProvider client={client}><VendoSlot id="net-worth-card" /></VendoProvider>);
    expect(knownSlots()).toEqual([{ id: "net-worth-card", label: "Net worth card" }]);
  });

  it("notes it even when the slot renders the host's children untouched", () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    expect(knownSlots()).toEqual([{ id: "hero", label: "Hero" }]);
  });

  it("notes every slot on the page, once each", () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoSlot id="sidebar_feed" />
      </VendoProvider>,
    );
    expect(knownSlots().map(note => note.label)).toEqual(["Hero", "Sidebar feed"]);
  });
});

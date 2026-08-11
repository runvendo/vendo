// @vitest-environment jsdom
// A mounted slot is the ONLY thing that knows a slot exists, so every VendoSlot
// says so to the registry — in every state, including the one where it renders
// the host's own markup untouched. Nothing below stubs the report path: the
// slots write through the real client to the real wire fixture, and the
// assertions read that server's own state back.
import { SLOT_REPORT_REFRESH_MS } from "@vendoai/core";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const tree = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", props: { text: "pinned" } }],
} as const;

describe("a mounted VendoSlot reports itself to the registry", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  const reports = () => wire.requests.filter(item => item.method === "POST" && item.path === "/slots");

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  it("reports the slot with a human label derived from its id", async () => {
    render(<VendoProvider client={client}><VendoSlot id="net-worth-card" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots).toEqual([
      { id: "net-worth-card", label: "Net worth card", lastSeen: expect.any(String) },
    ]));
  });

  it("reports it even when the slot renders the host's children untouched", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero"><span>Original hero</span></VendoSlot>
      </VendoProvider>,
    );
    await waitFor(() => expect(wire.state.slots.map(slot => slot.label)).toEqual(["Hero"]));
  });

  it("takes the host's own words when it is given a label", async () => {
    render(<VendoProvider client={client}><VendoSlot id="insights-custom-view" label="Insights" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots.map(slot => slot.label)).toEqual(["Insights"]));
  });

  it("sends a whole page of slots as ONE report", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoSlot id="sidebar_feed" />
        <VendoSlot id="net-worth-card" />
      </VendoProvider>,
    );
    await waitFor(() => expect(wire.state.slots).toHaveLength(3));
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.body).toEqual({
      slots: [
        { id: "hero", label: "Hero" },
        { id: "sidebar_feed", label: "Sidebar feed" },
        { id: "net-worth-card", label: "Net worth card" },
      ],
    });
  });

  it("says a given (id, label) once per refresh window, however often the slot mounts", async () => {
    const page = () => (
      <VendoProvider client={client}><VendoSlot id="hero"><span>Original hero</span></VendoSlot></VendoProvider>
    );
    const first = render(page());
    await waitFor(() => expect(reports()).toHaveLength(1));
    first.rerender(page());
    first.unmount();
    render(page());
    // A remount re-runs the effect; the registry hears nothing new.
    await waitFor(() => expect(wire.state.slots).toHaveLength(1));
    expect(reports()).toHaveLength(1);
  });

  it("renews a slot the client already reported once the refresh window passes", async () => {
    // The registry drops a row SLOT_DECAY_MS after its last report. A client
    // that lives longer than that — one tab, open for weeks — would watch its
    // own mounted slot age out and stop being offered as a destination, so the
    // dedupe note expires well before the row does.
    const page = () => <VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>;
    const first = render(page());
    await waitFor(() => expect(reports()).toHaveLength(1));
    first.unmount();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SLOT_REPORT_REFRESH_MS + 1);
    render(page());
    await waitFor(() => expect(reports()).toHaveLength(2));
    expect(reports()[1]?.body).toEqual({ slots: [{ id: "hero", label: "Hero" }] });
  });

  it("renews a slot that never re-mounts — the poll loop reports it, not the effect", async () => {
    // The harder half of the same lease: `useReportSlot` fires on mount, so one
    // tab left open on one page has no second mount to renew with. Nothing here
    // rerenders or remounts; the placement poller is what has to notice.
    render(<VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>);
    await waitFor(() => expect(reports()).toHaveLength(1));

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SLOT_REPORT_REFRESH_MS + 1);
    // The renewal rides the 5s poll tick, so this waits on a real interval. The
    // poll budget is deliberately LOOSER than the test's own timeout: the test
    // timeout is the hang-detector, and a tighter inner limit would call a busy
    // machine a product bug.
    await waitFor(() => expect(reports()).toHaveLength(2), { timeout: 30_000 });
    expect(reports()[1]?.body).toEqual({ slots: [{ id: "hero", label: "Hero" }] });
  }, 20_000);

  it("re-reports the same slot under a NEW label", async () => {
    const { rerender } = render(<VendoProvider client={client}><VendoSlot id="hero" label="Hero" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots.map(slot => slot.label)).toEqual(["Hero"]));
    rerender(<VendoProvider client={client}><VendoSlot id="hero" label="Home hero" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots.map(slot => slot.label)).toEqual(["Home hero"]));
  });

  it("leaves host-asserted slots out — a destination the person picks must be one a placement would reach", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="asserted-app" appId="app_1" />
        <VendoSlot id="asserted-pin" pin={{ payload: tree }} />
        <VendoSlot id="self-resolving" />
      </VendoProvider>,
    );
    // The self-resolving slot in the same commit is the control: the report DID
    // go out, and these two were left out of it.
    await waitFor(() => expect(wire.state.slots.map(slot => slot.id)).toEqual(["self-resolving"]));
    expect(reports()).toHaveLength(1);
  });
});

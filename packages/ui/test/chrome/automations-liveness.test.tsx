// @vitest-environment jsdom
// The panel's run state has to age with the runs themselves.
//
// The panel used to poll a CLOCK and nothing else: a 30s `setNow` interval fed
// the next-run countdown while the rows, the approvals and the run lists were
// fetched exactly once. Two user-facing failures fell out of that one gap —
// an away run that started after the fetch was never seen "running", so its
// Stop button never rendered and the kill switch was unreachable; and a run
// that finished left the open history showing "No runs yet" until a reload.
//
// These drive the REAL wire server and mutate its state between polls, so the
// panel is proven against a server that actually changed its mind — a harness
// that re-rendered the same fixture would pass without any poll at all.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { AutomationsPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

// Fast enough that a test never waits on the shipped 5s cadence, slow enough
// that the first paint still settles before the first tick.
const POLL_MS = 25;

describe("AutomationsPanel liveness", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("shows a run that starts while the panel is open, with its Stop button", async () => {
    // Nothing has run yet, so there is no Stop button to find and no way for the
    // assertion below to pass on the fixture's own seed data.
    wire.state.runs = [];
    render(<VendoProvider client={client}><AutomationsPanel pollMs={POLL_MS} /></VendoProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Run history" }));
    await waitFor(() => expect(screen.getByText("No runs yet.")).toBeTruthy());

    // The schedule fires while the person is watching the panel.
    wire.state.runs = [{
      id: "run_live",
      appId: "app_auto",
      trigger: { kind: "host-event", event: "invoice.created" },
      status: "running",
      startedAt: new Date().toISOString(),
      steps: [],
    }];

    // The row appears AND the kill switch with it — the whole point of seeing it.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
    expect(screen.queryByText("No runs yet.")).toBeNull();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("updates a completing run without a reload", async () => {
    wire.state.runs = [{
      id: "run_live",
      appId: "app_auto",
      trigger: { kind: "host-event", event: "invoice.created" },
      status: "running",
      startedAt: new Date().toISOString(),
      steps: [],
    }];
    render(<VendoProvider client={client}><AutomationsPanel pollMs={POLL_MS} /></VendoProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Run history" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());

    // It finishes on the server. Nobody reloads, nobody clicks anything.
    wire.state.runs = [{
      id: "run_live",
      appId: "app_auto",
      trigger: { kind: "host-event", event: "invoice.created" },
      status: "ok",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [],
    }];

    await waitFor(() => expect(screen.getByText("Succeeded")).toBeTruthy());
    // A finished run offers no kill switch, and stops claiming to be live.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText("running now")).toBeNull();
  });

  // Both cadence tests below take their baseline AFTER the initial load has gone
  // quiet. Snapshotting the request count the moment the first button renders
  // counts the mount fetches that are still in flight, which reads as a poll
  // that isn't there.
  const runRequests = () => wire.requests.filter(entry => entry.path.startsWith("/runs")).length;
  const quiet = () => new Promise(resolve => setTimeout(resolve, POLL_MS * 6));

  it("asks for nothing while the tab is hidden", async () => {
    render(<VendoProvider client={client}><AutomationsPanel pollMs={POLL_MS} /></VendoProvider>);
    await screen.findByRole("button", { name: "Run history" });
    // Proof the poll is running at all, so the assertion below can't pass just
    // because nothing ever polls.
    await waitFor(() => expect(runRequests()).toBeGreaterThan(1));

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await quiet();
    const settled = runRequests();
    await quiet();
    try {
      // A tab nobody is looking at costs the deployment nothing.
      expect(runRequests()).toBe(settled);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });

  it("polls nothing at all when the host turns the cadence off", async () => {
    render(<VendoProvider client={client}><AutomationsPanel pollMs={0} /></VendoProvider>);
    await screen.findByRole("button", { name: "Run history" });
    await quiet();
    const settled = wire.requests.length;
    await quiet();
    expect(wire.requests.length).toBe(settled);
  });
});

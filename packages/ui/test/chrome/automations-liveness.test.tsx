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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  // The kill switch used to live ONLY inside the expanded Run history, so the
  // person watching the row say "running now" had no way to stop it without
  // first guessing that a collapsed panel held the button. The trigger row is
  // where the run is being watched, so that is where the stop belongs.
  it("carries Stop on the trigger row itself, without Run history ever being opened", async () => {
    // pollMs 0 on purpose: nothing here may be explained by a background
    // re-fetch. The button and the settled row are the panel's own doing.
    render(<VendoProvider client={client}><AutomationsPanel pollMs={0} /></VendoProvider>);

    // Named for its trigger, the way the row's toggle is — two same-labelled
    // controls on one page are two controls nobody can tell apart.
    const stop = await screen.findByRole("button", { name: "Stop Invoice watcher — Invoice created" });
    expect(screen.queryByRole("group", { name: /^Run history/ })).toBeNull();
    expect(screen.getByText(/running now/)).toBeTruthy();

    fireEvent.click(stop);

    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/runs/run_1/stop" }),
    ));
    // The row stops claiming a run it just killed, and the stop it offered goes
    // with it.
    await waitFor(() => expect(screen.queryByText(/running now/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Stop Invoice watcher — Invoice created" })).toBeNull();
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

  it("keeps the run-health strip when a refresh lands while /runs is still in flight", async () => {
    // The eager strip fetch discards its own response whenever the effect
    // restarts, and a restart is just a new `automations` array — which every
    // refresh produces. The restarted effect finds the row still marked as
    // fetched and skips it, and the discarded response then UNMARKS it, so
    // nothing is in flight and nothing will re-fetch: the effect only re-runs on
    // the next identity change. With the poll on, the run sweep quietly covers
    // for this a tick later; with the cadence off (a host driving its own
    // refreshes — pollMs=0) there is no sweep, and the health strip is simply
    // gone for the rest of the session.
    const slow: VendoClient = {
      ...client,
      runs: {
        ...client.runs,
        list: async (filter) => {
          await new Promise(resolve => setTimeout(resolve, 120));
          return client.runs.list(filter);
        },
      },
    };
    render(<VendoProvider client={slow}><AutomationsPanel pollMs={0} /></VendoProvider>);
    const toggle = await screen.findByRole("switch", { name: "Enable Invoice watcher — Invoice created" });
    // A person arms their automation while the first strip read is still out:
    // `enable` refreshes, and that refresh is the restart.
    fireEvent.click(toggle);
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/automations/app_auto/enable/main" }),
    ));

    expect(await screen.findByRole("img", { name: /^Last \d+ runs? for/ })).toBeTruthy();
  });

  it("keeps the newest /runs answer when an older read lands after it", async () => {
    // Several reads of ONE row can be in flight at once: the eager strip read,
    // plus a sweep that fires on a timer and never waits for the previous tick.
    // The one that LANDS last used to win, which is not the one that was ISSUED
    // last — so a slow read overwrites a fresh one and the strip goes BACKWARDS
    // on screen: a run the person just watched succeed reverts to Failed.
    const run = (status: "ok" | "error") => ({
      id: "run_1",
      appId: "app_auto" as const,
      triggerId: "main",
      trigger: { kind: "host-event" as const, event: "invoice.created" },
      status,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [],
    });
    wire.state.runs = [run("error")];

    // The two reads land in an order this test chooses, rather than one a sleep
    // hopes for: the FIRST read issued is released last, by hand. Every other
    // read answers honestly, so nothing here depends on starving the panel.
    let releaseOlder = (): void => undefined;
    const olderLands = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let reads = 0;
    const racing: VendoClient = {
      ...client,
      runs: {
        ...client.runs,
        list: async (filter) => {
          reads += 1;
          if (reads > 1) return client.runs.list(filter);
          // Issued FIRST, and answers with the truth as it stood then...
          const older = await client.runs.list(filter);
          // ...the run then succeeds, so every later read says so...
          wire.state.runs = [run("ok")];
          await olderLands;
          return older;
        },
      },
    };
    // A cadence far wider than one round trip, so the assertion below is about
    // the older answer landing and not about the next tick racing to heal it —
    // which at the shipped 5s cadence it would not do for five seconds.
    render(<VendoProvider client={racing}><AutomationsPanel pollMs={200} /></VendoProvider>);

    const rollup = () => screen.getByRole("img", { name: /^Last \d+ runs? for/ }).getAttribute("aria-label");
    // The newer read has landed and the row says the run succeeded.
    await waitFor(() => expect(rollup()).toContain("1 ok"));

    // Hide the tab, then let anything already in flight land. The panel issues
    // no sweep reads while hidden, so from here the older read is the ONLY
    // unresolved one — the assertion is about ITS answer, not about the next
    // tick racing to heal the row (at the shipped 5s cadence it would not).
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
      expect(rollup()).toContain("1 ok");

      // Now the older read finally answers. It may not be believed.
      await act(async () => { releaseOlder(); });
      expect(rollup()).toContain("1 ok");
      expect(rollup()).not.toContain("failed");
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
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

// @vitest-environment jsdom
// RISK RE-CHECK — what a REFUSED report does to the rest of the session.
//
// The caps that just landed on POST /slots (packages/vendo/src/wire/slots.ts —
// at most 200 entries, each id and label 1-256 characters) turned a 400 on this
// route from something a host page could not realistically provoke into
// something one prop can: a label longer than 256 characters, on any slot. The
// route validates the array all-or-nothing (`reported.map(descriptor)`), so
// that one entry refuses the WHOLE batch — and a page reports every one of its
// slots in a single batch by design (use-placements.ts).
//
// The client's side of that refusal is `report` in hooks/use-placements.ts: it
// adds the key to `reported` BEFORE the request is sent, and swallows the
// rejection. Its own comment there says "a slot that failed to report gets
// another chance from the next page that mounts it". It does not: `reported` is
// keyed by the CLIENT, which outlives the React tree, so a failed report is
// indistinguishable from a successful one for the rest of the session.
//
// Nothing is stubbed — the slots write through the real client to the real wire
// fixture, whose /slots route mirrors the real caps, and the assertions read
// that server's own state back.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("a refused slot report must not silence the session", () => {
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

  it("tries again on a later page when the report failed for a transient reason", async () => {
    // The server was briefly unavailable — the case the source comment is
    // written about, and the one where retrying is unambiguously right.
    wire.state.failures.push({
      method: "POST",
      path: "/slots",
      code: "not-implemented",
      message: "Internal Vendo error",
      status: 503,
    });
    const page = () => (
      <VendoProvider client={client}>
        <VendoSlot id="hero" />
        <VendoSlot id="sidebar" />
      </VendoProvider>
    );

    const first = render(page());
    await waitFor(() => expect(reports()).toHaveLength(1));
    expect(wire.state.slots).toEqual([]);
    first.unmount();

    // The next page mounts the same two slots. The refusal was one-shot, so the
    // registry should now learn about them.
    render(page());
    await waitFor(() => expect(wire.state.slots.map(slot => slot.id).sort())
      .toEqual(["hero", "sidebar"]));
  });

  it("keeps the rest of the page in the picker when one slot's label is over the cap", async () => {
    // One host prop — a label longer than the route's 256-character ceiling —
    // must not remove every OTHER slot on the page from the "Add to…" picker.
    // WHERE that is answered was a spec decision, settled: the client CLAMPS an
    // over-long label rather than dropping the entry, because a verbose label is
    // still a real destination. (Skipping is reserved for an unusable id, which
    // names nothing.) So both slots survive, and the long one arrives trimmed.
    render(
      <VendoProvider client={client}>
        <VendoSlot id="hero" label={"x".repeat(300)} />
        <VendoSlot id="sidebar" />
      </VendoProvider>,
    );

    await waitFor(() => expect(wire.state.slots.map(slot => slot.id).sort())
      .toEqual(["hero", "sidebar"]));
    // The clamp itself, not just survival: the route would have refused 300.
    expect(wire.state.slots.find(slot => slot.id === "hero")?.label).toHaveLength(256);
  });
});

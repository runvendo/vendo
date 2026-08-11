// @vitest-environment jsdom
// RISK ROUND — the slot registry's once-per-session dedupe key.
//
// `report` in hooks/use-placements.ts remembers every (id, label) pair it has
// sent for the life of the client. It used to build that memory by joining the
// two with a SPACE (`${slot} ${label}`), and a space is legal on both sides, so
// the join was not injective: ("sales report", "Q3") and ("sales", "report Q3")
// produced the same key. The second slot was then treated as already reported
// and never reached the registry — for the whole session, on every page that
// mounted it.
//
// The consequence was not cosmetic: the registry is the ONLY source the
// "Add to…" picker has for destinations, so the shadowed slot was a place the
// person could never send a generated view, with nothing on screen to say why.
// The key is the JSON of the pair now; these cases hold it there.
//
// Same seam discipline as slot-report.test.tsx: nothing is stubbed — the slots
// write through the real client to the real wire fixture, and the assertion
// reads that server's own state back.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("the once-per-session dedupe key must not merge two different slots", () => {
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

  it("reports both slots when their (id, label) pairs join to the same string", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSlot id="sales report" label="Q3" />
        <VendoSlot id="sales" label="report Q3" />
      </VendoProvider>,
    );

    // Both slots are mounted, self-resolving, and distinct. Both are
    // destinations. Today only the first one ever reaches the registry.
    await waitFor(() => expect(wire.state.slots.map(slot => slot.id).sort())
      .toEqual(["sales", "sales report"]));
  });

  it("still reports the second slot when it mounts on a later page of the same session", async () => {
    // The dedupe set outlives the React tree — it is keyed by the CLIENT — so a
    // shadowed slot does not recover by being on a different page.
    const first = render(<VendoProvider client={client}><VendoSlot id="a b" label="c" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots.map(slot => slot.id)).toEqual(["a b"]));
    first.unmount();

    render(<VendoProvider client={client}><VendoSlot id="a" label="b c" /></VendoProvider>);
    await waitFor(() => expect(wire.state.slots.map(slot => slot.id).sort()).toEqual(["a", "a b"]));
  });
});

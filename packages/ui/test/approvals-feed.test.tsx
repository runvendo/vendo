// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, useAttention, type VendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

/**
 * Post-check H15 — the ONE approvals poller. The launcher pill, the waiting
 * strip and the center's rail all read the same asks; before this they each
 * held their own interval, so a host mounting both surfaces spent 36 requests a
 * minute with nothing waiting.
 *
 * The load-bearing proofs here are COUNTING proofs, not rate proofs: three
 * surfaces mount on exactly one GET, and one decision costs exactly one refresh.
 * Where polling cadence has to be involved at all, the assertion is on ELAPSED
 * TIME rather than on ticks-in-a-window — jitter can only make elapsed longer,
 * which is the safe direction, whereas the defect (N independent pollers) makes
 * it shorter. Counting ticks in a fixed real-time window does NOT work: measured
 * on a loaded laptop the same 250ms window produced 3 polls once and 7 the next,
 * so any ±1 tolerance between two such windows is a coin flip, not a gate.
 */

const CADENCE_MS = 25;
const WINDOW_MS = 250;
/** Enough polls that (N-2) cadences is a real floor rather than one tick. */
const POLLS_MEASURED = 6;

function Surface({ pollMs }: { pollMs: number }) {
  const { askCount, asks, decide } = useAttention({ pollMs });
  return (
    <>
      <span data-testid="count">{askCount}</span>
      <button type="button" onClick={() => void decide(asks.map(ask => ask.id), { approve: true })}>Approve</button>
    </>
  );
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("the shared approvals feed", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    // A fresh client per test is a fresh feed (the store is keyed by client).
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const polls = () => wire.requests.filter(request => request.method === "GET" && request.path === "/approvals").length;

  it("mounts three surfaces on ONE request, and they all show the same count", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
      </VendoProvider>,
    );
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["1", "1", "1"]));
    // The whole point: three mounted surfaces, one GET.
    expect(polls()).toBe(1);
  });

  it("serializes three surfaces onto one cadence instead of tripling it", async () => {
    const together = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    // The feed is SELF-SCHEDULING: each poll arms the next only once it settled,
    // so N polls cost at least (N-1) cadences of wall clock however many
    // surfaces are mounted. Three independent pollers would reach the same count
    // in a third of the time — the failure mode makes this number SMALLER, and
    // machine load only makes it bigger, so the bound is safe in one direction.
    const started = Date.now();
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(POLLS_MEASURED), { timeout: 5_000 });
    const elapsed = Date.now() - started;
    together.unmount();
    expect(elapsed).toBeGreaterThanOrEqual((POLLS_MEASURED - 2) * CADENCE_MS);
  });

  it("stops entirely when the last surface unmounts", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    await waitFor(() => expect(polls()).toBeGreaterThan(1));
    view.unmount();
    // The unsubscribe stops the timer and drops the in-flight RESULT, but a
    // request already on the wire still arrives and the server still counts it
    // (the sibling visibility case says the same thing out loud). Let that one
    // land, THEN demand a full window of silence — ten cadences in which a live
    // poller could not have stayed quiet. Stricter than asserting equality
    // across the drain, and without the race.
    await settle(WINDOW_MS);
    const after = polls();
    await settle(WINDOW_MS);
    expect(polls()).toBe(after);
  });

  it("pauses while the document is hidden and catches up on return", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const show = (next: DocumentVisibilityState) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };

    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    await waitFor(() => expect(polls()).toBeGreaterThan(1));

    show("hidden");
    // The in-flight request may still land; one more is the ceiling.
    const paused = polls() + 1;
    await settle(WINDOW_MS);
    expect(polls()).toBeLessThanOrEqual(paused);

    const before = polls();
    show("visible");
    await waitFor(() => expect(polls()).toBeGreaterThan(before));
    view.unmount();
  });

  // H2-E / #1372: a signed-out visitor's feed must go quiet after the first
  // forbidden refusal — the field failure was every poller retrying a 403
  // forever — and wake on the page's identity signal.
  it("stops entirely on a forbidden refusal, and wakes on the identity signal", async () => {
    for (let i = 0; i < 8; i += 1) {
      wire.state.failures.push({
        method: "GET",
        path: "/approvals",
        code: "forbidden",
        message: "no identity for this request",
        status: 403,
      });
    }
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={CADENCE_MS} />
      </VendoProvider>,
    );
    // The first refusal lands…
    await waitFor(() => expect(polls()).toBe(1));
    // …and then a full window of silence: a live poller could not stay quiet
    // for ten cadences (the unmount test's own bound).
    await settle(WINDOW_MS);
    expect(polls()).toBe(1);
    // A tab switch is not a sign-in.
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(WINDOW_MS);
    expect(polls()).toBe(1);
    // The host announces a sign-in: exactly one immediate re-read, and because
    // the queue still holds refusals it latches again rather than resuming.
    window.dispatchEvent(new Event("vendo:identity-changed"));
    await waitFor(() => expect(polls()).toBe(2));
    await settle(WINDOW_MS);
    expect(polls()).toBe(2);
    // A second signal against a wire that now answers: the feed resumes fully.
    wire.state.failures.length = 0;
    window.dispatchEvent(new Event("vendo:identity-changed"));
    await waitFor(() => expect(view.getByTestId("count").textContent).toBe("1"));
    await waitFor(() => expect(polls()).toBeGreaterThan(3));
    view.unmount();
  });

  it("one decision clears every surface, with no extra fetch per surface", async () => {
    const view = render(
      <VendoProvider client={client}>
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
        <Surface pollMs={5_000} />
      </VendoProvider>,
    );
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["1", "1", "1"]));
    const before = polls();
    fireEvent.click(view.getAllByRole("button", { name: "Approve" })[0]!);
    await waitFor(() => expect(view.getAllByTestId("count").map(node => node.textContent)).toEqual(["0", "0", "0"]));
    // One refresh answered all three surfaces, not one each.
    expect(polls()).toBe(before + 1);
    view.unmount();
  });
});

/**
 * H-6 — the feed's change detector compared IDS only, so an ask that CHANGED
 * without changing its id never reached the surfaces reading it. Both cases
 * below happen to a real ask: `risk` is resolved per call (dynamic
 * `resolveRisk`) and `invalidatedGrant` is attached after the fact.
 */
describe("a re-graded ask reaches the surfaces (H-6)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => { await wire.close(); });

  function Chip() {
    const { asks } = useAttention({ pollMs: CADENCE_MS });
    return (
      <>
        <span data-testid="risk">{asks[0]?.descriptor.risk ?? "none"}</span>
        <span data-testid="invalidated">{asks[0]?.invalidatedGrant === undefined ? "no" : "yes"}</span>
      </>
    );
  }

  it("re-grades read → destructive under the same id, and shows a late invalidatedGrant", async () => {
    wire.state.approvals[0]!.descriptor.risk = "read";
    const view = render(<VendoProvider client={client}><Chip /></VendoProvider>);
    await waitFor(() => expect(view.getByTestId("risk").textContent).toBe("read"));

    wire.state.approvals[0]!.descriptor.risk = "destructive";
    wire.state.approvals[0]!.invalidatedGrant = { id: "grt_1", grantedAt: "2026-07-11T12:00:00.000Z" };
    await waitFor(() => expect(view.getByTestId("risk").textContent).toBe("destructive"));
    expect(view.getByTestId("invalidated").textContent).toBe("yes");
  });
});

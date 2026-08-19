/**
 * The connect gate's lookup runs TWICE for one tool call — the tool-bridge
 * preflight rules the call out before the guard can mint an approval for it,
 * and the gate-wrapped registry rules it out again on the door that does not
 * preview (both checks are load-bearing; neither is redundant). A CONNECTED
 * toolkit was already free on the second ask, served from the 60s cache. A
 * refusal was not: it refetched, so every unconnected call paid two broker
 * round trips to say the same no.
 */
import type { Principal, RunContext } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendoComposition } from "../src/compose-context.js";
import { composeDiscovery } from "../src/compose-discovery.js";

const alice: Principal = { kind: "user", subject: "user_alice" };
const ctx = { principal: alice } as RunContext;

/** The discovery lane over a connections adapter that counts its lookups. */
function discovery(accounts: () => Array<{ toolkit: string; status: string }>) {
  let lookups = 0;
  const composition = {
    connections: {
      list: async () => {
        lookups += 1;
        return accounts();
      },
    },
  } as unknown as VendoComposition;
  return { ...composeDiscovery(composition), lookups: () => lookups };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the connect gate's toolkit lookup", () => {
  it("costs ONE broker round trip for a refusal, not one per check", async () => {
    const lane = discovery(() => []);

    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(false);
    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(false);

    expect(lane.lookups()).toBe(1);
  });

  it("still serves a connected toolkit from the cache", async () => {
    const lane = discovery(() => [{ toolkit: "gmail", status: "active" }]);

    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(true);
    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(true);

    expect(lane.lookups()).toBe(1);
  });

  it("re-asks the moment the refusal's second is up, so a user who just connected is not stuck", async () => {
    vi.useFakeTimers();
    let connected = false;
    const lane = discovery(() => (connected ? [{ toolkit: "gmail", status: "active" }] : []));

    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(false);
    connected = true;
    vi.advanceTimersByTime(1_000);

    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(true);
    expect(lane.lookups()).toBe(2);
  });

  it("does not let one toolkit's refusal answer for another", async () => {
    const lane = discovery(() => [{ toolkit: "gmail", status: "active" }]);

    expect(await lane.subjectHasToolkit("slack", ctx)).toBe(false);
    expect(await lane.subjectHasToolkit("gmail", ctx)).toBe(true);
  });
});

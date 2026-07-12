import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// P2-B: a "constrained" scope with an empty constraints array is an
// every()-over-nothing → true, i.e. a tool-wide wildcard wearing a label the
// preview implies is narrow. Both mint-time validation and match-time
// evaluation must fail closed.
describe("empty constrained grant is not a wildcard (P2-B)", () => {
  it("rejects an approval that remembers a constrained scope with zero constraints", async () => {
    const store = createMemoryStore();
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { risk: "destructive" }, action: "ask" }] },
    });
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(
      call("host_destructive", { amount: 1 }, "call_empty"),
      context(),
    );
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");

    await expect(
      guard.approvals.decide(
        parked.approvalId,
        {
          approve: true,
          remember: { scope: { kind: "constrained", constraints: [] }, duration: "standing" },
        },
        alice,
      ),
    ).rejects.toMatchObject({ code: "validation" });

    // The rejected remember left no grant behind.
    expect(await guard.grants.list(alice)).toEqual([]);
  });

  it("does not authorize a call from a stored grant that carries empty constraints", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_stored_empty" });
    // Simulate a pre-existing/injected stored grant that skipped mint validation.
    await seedGrant(store, { descriptor: d, scope: { kind: "constrained", constraints: [] } });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: d.name }, action: "block", note: "no grant" }] },
    });

    // scopeMatches fails closed → the grant is skipped → the rule blocks.
    // (Before the fix this would be { action: "run", decidedBy: "grant" }.)
    await expect(
      guard.check(call(d.name, { anything: "goes" }, "call_stored"), d, context()),
    ).resolves.toMatchObject({ action: "block", decidedBy: "rule" });
  });
});

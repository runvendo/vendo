import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §2: a confirmEach descriptor always asks — unsuppressible by grant, rule, or
// judge. Only a single-use approved replay of the EXACT same call runs it.
describe("confirmEach tier is unsuppressible (05 §2)", () => {
  it("parks a confirmEach call even with a grant, a run-rule, and a run-judge all agreeing", async () => {
    const store = createMemoryStore();
    const d = descriptor("destructive", { name: "host_crit", confirmEach: true });
    await seedGrant(store, { descriptor: d }); // standing tool grant that would otherwise run it
    const guard = createGuard({
      store,
      policy: { rules: [{ match: {}, action: "run" }] }, // permissive rule
      judge: { decide: async () => ({ action: "run", rationale: "judge says run" }) },
    });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);
    const c = call(d.name, { accountId: "acct_1" }, "call_crit");

    // Every non-confirmEach stage says run; the confirmEach tier still parks.
    await expect(guard.check(c, d, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "confirmEach",
    });
    const parked = await bound.execute(c, context());
    expect(parked).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
    if (parked.status !== "pending-approval") throw new Error("expected the confirmEach call to park");

    // A single approved replay of the EXACT same call runs exactly once.
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);

    // The approval is single-use: a second identical execute parks again.
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(1);
  });

  it("does not let one confirmEach approval satisfy a different confirmEach call", async () => {
    const store = createMemoryStore();
    const d = descriptor("destructive", { name: "host_crit2", confirmEach: true });
    const guard = createGuard({ store, policy: { rules: [{ match: {}, action: "run" }] } });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    const parked = await bound.execute(call(d.name, { accountId: "acct_1" }, "call_a"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the confirmEach call to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // A different confirmEach call (different id + args) is not covered by that approval.
    await expect(
      bound.execute(call(d.name, { accountId: "acct_2" }, "call_b"), context()),
    ).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);

    // The genuine approved call still runs once.
    await expect(
      bound.execute(call(d.name, { accountId: "acct_1" }, "call_a"), context()),
    ).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });
});

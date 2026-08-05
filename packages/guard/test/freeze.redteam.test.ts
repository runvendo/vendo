import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

// RED-TEAM. Not a spec of intended behaviour — each test here asserts what the
// SHIPPED CONTRACT promises, so a green run means the defect is fixed.

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

describe("the frozen audit row's risk chip", () => {
  // `AuditEvent.risk` (packages/core/src/audit.ts) documents itself as "the risk
  // the guard actually gated on — the EFFECTIVE grade, after any `resolveRisk`,
  // not the descriptor's static label". Every other row in the guard honours
  // that: the ask, block, tool-call and org-policy rows all chip
  // `effectiveDescriptor.risk`. The frozen row chips `descriptor.risk`, the
  // DECLARED label, so the one row a fintech reads during an emergency stop is
  // the one row whose grade can understate the call it refused.
  it("carries the effective grade the field's contract promises, not the declared one", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      // A host that grades by ARGUMENTS, which is the whole point of the seam:
      // the declared label is `read`, the money-moving call is `destructive`.
      resolveRisk: (toolCall) =>
        (toolCall.args as { amount?: number }).amount !== undefined ? "destructive" : undefined,
    });
    const bound = guard.bind(new FixtureTools());
    const wire = call("host_read", { amount: 250_000 }, "call_wire");

    // Unfrozen, the ledger tells the truth: the row carries the resolved grade.
    await bound.execute(wire, context());
    const beforeRows = (await guard.audit.query({ kind: "tool-call", limit: 10 })).events;
    expect(beforeRows[0]).toMatchObject({ tool: "host_read", risk: "destructive" });

    await guard.freeze("ops_yousef");
    expect(await guard.check(wire, descriptor("read"), context())).toMatchObject({
      action: "block",
      decidedBy: "frozen",
    });

    const frozenRow = (await guard.audit.query({ kind: "policy-decision", limit: 50 })).events
      .find((event) => event.decidedBy === "frozen" && event.tool === "host_read");
    expect(frozenRow).toBeDefined();
    // The same call, the same resolver, the same ledger — the emergency-stop row
    // must not grade it lower than the row written seconds earlier.
    expect(frozenRow).toMatchObject({ outcome: "blocked", risk: "destructive" });
  });
});

// Every drawer this block owns — approvals, grants, audit, the effect ledger,
// the freeze switch, the transition receipts — is Vendo's OWN data, so it
// reaches the store through the named `engine` family and its allowlist, never
// through the generic `records.*` door a host uses for its own rows.
//
// The counterparty here is the REAL in-core StoreOps reference
// (`memoryStoreOps`), gate included: the flow writes through the guard and
// reads back through that same surface, so neither side can mock the other into
// agreeing.
import { isEngineCollection, type StoreOps } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, FixtureTools, call, context } from "./fixtures/tools.js";

interface Op {
  family: "engine" | "records";
  verb: string;
  collection: string;
}

/** The real memory StoreOps with a note taken of every collection-addressed
 *  call. A spy, not a stub: each verb delegates, so the reads below come back
 *  through the same surface the writes went out on. */
function recordingOps(): { ops: StoreOps; traffic: Op[] } {
  const real = memoryStoreOps();
  const traffic: Op[] = [];
  const note = (family: Op["family"], verb: string, collection: string): void => {
    traffic.push({ family, verb, collection });
  };
  const family = (name: Op["family"], door: StoreOps["engine"]): StoreOps["engine"] => ({
    get: (c, id) => (note(name, "get", c), door.get(c, id)),
    put: (c, record) => (note(name, "put", c), door.put(c, record)),
    delete: (c, id) => (note(name, "delete", c), door.delete(c, id)),
    list: (c, query) => (note(name, "list", c), door.list(c, query)),
    claim: (c, expected, replacement) => (note(name, "claim", c), door.claim(c, expected, replacement)),
    insertIfAbsent: (c, record) => (note(name, "insertIfAbsent", c), door.insertIfAbsent(c, record)),
    compareAndSwap: (c, record, revision) =>
      (note(name, "compareAndSwap", c), door.compareAndSwap(c, record, revision)),
  });
  return {
    ops: { ...real, engine: family("engine", real.engine), records: family("records", real.records) },
    traffic,
  };
}

const runCtx = context({ trigger: { runId: "run_engine_1", kind: "schedule" } });

/** Park a write, approve it with a standing grant, replay it, then read the
 *  freeze switch, the audit log and the grant list — one pass over every
 *  collection the guard owns. */
async function exerciseEveryDrawer(): Promise<{ ops: StoreOps; traffic: Op[] }> {
  const { ops, traffic } = recordingOps();
  const guard = createGuard({
    store: createMemoryStore(),
    ops,
    policy: { rules: [{ match: {}, action: "ask" }] },
  });
  const tools = new FixtureTools();
  const bound = guard.bind(tools);
  const write = call("host_write", { amount: 5 }, "call_engine_1");

  const parked = await bound.execute(write, runCtx);
  if (parked.status !== "pending-approval") throw new Error("expected the call to park");
  await guard.approvals.decide(
    parked.approvalId,
    { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    alice,
  );
  const ran = await bound.execute(write, runCtx);
  expect(ran.status).toBe("ok");
  expect(tools.executions).toHaveLength(1);

  await guard.freeze(alice.subject);
  expect(await guard.frozen()).toBe(true);
  await guard.audit.query({ principal: alice, limit: 50 });
  await guard.grants.list(alice);

  return { ops, traffic: [...traffic] };
}

describe("the guard's own drawers ride the engine family", () => {
  it("never touches the generic records door, and names only allowlisted collections", async () => {
    const { traffic } = await exerciseEveryDrawer();

    expect(traffic.filter((op) => op.family === "records")).toEqual([]);
    const collections = [...new Set(traffic.map((op) => op.collection))].sort();
    expect(collections.filter((c) => !isEngineCollection(c))).toEqual([]);
    expect(collections).toEqual([
      "guard:approval-claims",
      "guard:controls",
      "vendo_approvals",
      "vendo_audit",
      "vendo_effects",
      "vendo_grants",
    ]);
  });

  it("writes the effect receipt with insertIfAbsent, never a plain put", async () => {
    // Insert-once is the whole point of the ledger: a put would let a racing
    // writer overwrite the receipt of a payment that already went out.
    const { ops, traffic } = await exerciseEveryDrawer();
    const effects = traffic.filter((op) => op.collection === "vendo_effects");

    expect(effects.map((op) => op.verb)).toContain("insertIfAbsent");
    expect(effects.map((op) => op.verb)).not.toContain("put");
    // Read back through the same surface: exactly one receipt, and it carries
    // the acting subject the erase cascade matches on.
    const ledger = await ops.engine.list("vendo_effects", {});
    expect(ledger.records).toHaveLength(1);
    expect((ledger.records[0]!.data as { subject?: string }).subject).toBe(alice.subject);
  });

  it("claims an approval's one-time transition with insertIfAbsent", async () => {
    const { ops, traffic } = await exerciseEveryDrawer();
    const claims = traffic.filter((op) => op.collection === "guard:approval-claims");

    expect(claims.filter((op) => op.verb === "insertIfAbsent").length).toBeGreaterThan(0);
    expect(claims.map((op) => op.verb)).not.toContain("put");
    // The decide and the replay each spend one: `decided:` and `consumed:`.
    const receipts = await ops.engine.list("guard:approval-claims", {});
    expect(receipts.records.map((record) => record.id.split(":")[0]).sort())
      .toEqual(["consumed", "decided"]);
  });
});

describe("without an ops surface the same verbs run on the adapter", () => {
  it("fails an approval transition closed when the adapter has no atomic capability", async () => {
    // The engine verbs are unconditional, so a store that cannot insert-once
    // refuses rather than degrading to a put — single-use state is never
    // guaranteed by a read-then-write.
    const base = createMemoryStore();
    const guard = createGuard({
      store: {
        ...base,
        records(collection) {
          const { atomic: _atomic, ...rest } = base.records(collection);
          return rest;
        },
      },
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { amount: 5 }, "call_engine_2"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");

    await expect(guard.approvals.decide(parked.approvalId, { approve: true }, alice))
      .rejects.toMatchObject({ code: "not-implemented" });
  });

  it("still lands the row, through the adapter's own record door", async () => {
    // An unset `ops` is a route, not a downgrade: the same collection, the same
    // verb, the same row — and the allowlist gate runs in front of it too.
    const store = createMemoryStore();
    const guard = createGuard({ store });

    await expect(guard.report({
      id: "aud_1",
      at: new Date().toISOString(),
      kind: "tool-call",
      principal: alice,
      venue: "chat",
      presence: "present",
    })).resolves.toBeUndefined();
    expect((await store.records("vendo_audit").list({})).records).toHaveLength(1);
  });
});

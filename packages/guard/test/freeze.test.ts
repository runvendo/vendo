import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

function freezeRow(sqlStore: PGliteStore, frozen: boolean, by: string): Promise<unknown> {
  return sqlStore.records("guard:controls").put({
    id: "freeze",
    data: { frozen, by, at: new Date().toISOString() },
  });
}

describe("the freeze flag over the real store", () => {
  it("blocks every call while frozen and runs again once lifted", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_read");
    // A standing grant is the strongest authority short of a live person: the
    // freeze has to outrank it too.
    await seedGrant(sqlStore, { descriptor: descriptor("destructive") });
    const granted = call("host_destructive", { invoiceId: "inv_1" }, "call_granted");

    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });

    await guard.freeze("ops_yousef");
    expect(await guard.frozen()).toBe(true);

    // Even a DECLARED READ under no policy at all — the call the guard would
    // otherwise run without asking anyone.
    expect(await guard.check(read, descriptor("read"), context())).toEqual({
      action: "block",
      reason: "vendo is frozen — nothing runs until it is unfrozen",
      decidedBy: "frozen",
    });
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    await expect(bound.execute(granted, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);

    await guard.unfreeze("ops_yousef");
    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(granted, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(3);
  });

  it("writes the flag row the console reads, and audits both directions plus every blocked call", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(new FixtureTools());

    await guard.freeze("ops_yousef");
    const row = await sqlStore.query<{ data: { frozen: boolean; by: string; at: string } }>(
      "SELECT data FROM vendo_records WHERE collection = $1 AND id = $2",
      ["guard:controls", "freeze"],
    );
    expect(row.rows[0]?.data).toMatchObject({ frozen: true, by: "ops_yousef" });
    expect(row.rows[0]?.data.at).toEqual(expect.any(String));

    await bound.execute(call("host_write", { invoiceId: "inv_2" }, "call_write"), context());
    await guard.unfreeze("ops_yousef");

    const events = (await guard.audit.query({ kind: "policy-decision", limit: 50 })).events;
    expect(events).toHaveLength(3);
    const flips = events.filter((event) => event.principal.subject === "ops_yousef");
    expect(flips.map((event) => (event.detail as { reason?: unknown }).reason).sort()).toEqual([
      "frozen",
      "unfrozen",
    ]);
    expect(flips.map((event) => event.decidedBy)).toEqual(["frozen", "frozen"]);
    const blockedCall = events.find((event) => event.tool === "host_write");
    expect(blockedCall).toMatchObject({
      outcome: "blocked",
      decidedBy: "frozen",
      principal: { subject: alice.subject },
    });
    // The frozen short-circuit runs before risk resolution, so the block row it
    // writes omits `risk` — the same reason the control flip rows carry none.
    expect(blockedCall).not.toHaveProperty("risk");
    expect(flips.every((event) => event.risk === undefined)).toBe(true);
  });

  it("obeys a flag row written straight through the store, as the console writes it", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_console");

    await freezeRow(sqlStore, true, "console");
    expect(await guard.frozen()).toBe(true);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);

    await freezeRow(sqlStore, false, "console");
    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("omits the risk field on the frozen block row — the short-circuit grades nothing", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      // Grades by ARGUMENTS: the declared label is `read`, the money-moving
      // call resolves to `destructive`.
      resolveRisk: (toolCall) =>
        (toolCall.args as { amount?: number }).amount !== undefined ? "destructive" : undefined,
    });
    const bound = guard.bind(new FixtureTools());
    const wire = call("host_read", { amount: 250_000 }, "call_wire");

    // Unfrozen, the ledger carries the resolved (effective) grade.
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
    // The freeze short-circuit runs BEFORE resolveRisk, so it has no effective
    // grade to report. `risk` documents the EFFECTIVE grade, so the row OMITS
    // it rather than chip the possibly-wrong declared label.
    expect(frozenRow).toMatchObject({ outcome: "blocked" });
    expect(frozenRow).not.toHaveProperty("risk");
  });

  it("blocks at EXECUTE when the freeze lands after the check resolved to run — the tool never runs", async () => {
    const sqlStore = await store();
    // The check reads the freeze row at the top of the pipeline; the execute
    // re-read reads it again right before dispatch. Serve the FIRST read as
    // unfrozen (the check resolves to run) and every read after it as frozen —
    // the freeze that landed while the grants/judge pipeline was awaiting.
    let controlReads = 0;
    const frozenAfterFirstRead = new Proxy(sqlStore, {
      get(target, prop, receiver) {
        if (prop !== "records") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (collection: string) => {
          const inner = target.records(collection);
          if (collection !== "guard:controls") return inner;
          return new Proxy(inner, {
            get(innerTarget, innerProp, innerReceiver) {
              if (innerProp === "get") {
                return async () => {
                  controlReads += 1;
                  return controlReads === 1
                    ? null
                    : {
                        id: "freeze",
                        data: { frozen: true, by: "ops_yousef", at: new Date().toISOString() },
                      };
                };
              }
              const value = Reflect.get(innerTarget, innerProp, innerReceiver);
              return typeof value === "function" ? value.bind(innerTarget) : value;
            },
          });
        };
      },
    });
    const guard = createGuard({ store: frozenAfterFirstRead });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_race");

    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    // The tool was never dispatched, and the freeze WAS re-read at execute.
    expect(tools.executions).toHaveLength(0);
    expect(controlReads).toBeGreaterThanOrEqual(2);
  });

  it("returns the frozen block even when the audit write FAILS — the block is the truth, the audit is best-effort", async () => {
    const sqlStore = await store();
    // Set the switch straight through the store (guard.freeze() would itself try
    // to audit and reject); then make every vendo_audit write throw.
    await freezeRow(sqlStore, true, "console");
    const auditWriteFails = new Proxy(sqlStore, {
      get(target, prop, receiver) {
        if (prop !== "records") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (collection: string) => {
          const inner = target.records(collection);
          if (collection !== "vendo_audit") return inner;
          return new Proxy(inner, {
            get(innerTarget, innerProp, innerReceiver) {
              if (innerProp === "put") {
                return async () => {
                  throw new Error("vendo_audit unavailable");
                };
              }
              const value = Reflect.get(innerTarget, innerProp, innerReceiver);
              return typeof value === "function" ? value.bind(innerTarget) : value;
            },
          });
        };
      },
    });
    const guard = createGuard({ store: auditWriteFails });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_audit_down");

    // check() resolves to the block — it does not reject with the store error.
    await expect(guard.check(read, descriptor("read"), context())).resolves.toEqual({
      action: "block",
      reason: "vendo is frozen — nothing runs until it is unfrozen",
      decidedBy: "frozen",
    });
    // …and execute() blocks too, without dispatching the tool.
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });

  it("fails CLOSED on a control row that exists but does not parse, and audits it", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_malformed");

    // A row that EXISTS but carries no boolean `frozen` — a corrupted kill
    // switch. For a kill switch the safe direction is CLOSED: read it as
    // frozen, never as "run everything".
    await sqlStore.records("guard:controls").put({
      id: "freeze",
      data: { by: "console", at: new Date().toISOString() },
    });
    expect(await guard.frozen()).toBe(true);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);

    // …and the guard recorded that the control row was malformed.
    const events = (await guard.audit.query({ kind: "policy-decision", limit: 50 })).events;
    expect(
      events.some(
        (event) =>
          (event.detail as { malformedControlRow?: unknown } | undefined)?.malformedControlRow === true,
      ),
    ).toBe(true);
  });

  it("fails CLOSED when the controls read itself THROWS — contained into a block, not an exception", async () => {
    const sqlStore = await store();
    // A store whose freeze-row read throws, but whose other collections (the
    // audit trail included) still work. The guard must contain that read
    // failure into a frozen block, never let it escape execute() as a rejection
    // while it silently stops gating.
    const failingStore = new Proxy(sqlStore, {
      get(target, prop, receiver) {
        if (prop !== "records") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (collection: string) => {
          const inner = target.records(collection);
          if (collection !== "guard:controls") return inner;
          return new Proxy(inner, {
            get(innerTarget, innerProp, innerReceiver) {
              if (innerProp === "get") {
                return async () => {
                  throw new Error("controls read failed");
                };
              }
              const value = Reflect.get(innerTarget, innerProp, innerReceiver);
              return typeof value === "function" ? value.bind(innerTarget) : value;
            },
          });
        };
      },
    });
    const guard = createGuard({ store: failingStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_read_throws");

    // A block, not a rejection; nothing ran.
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);

    // …and the guard noted that the control row was unreadable.
    const events = (await guard.audit.query({ kind: "policy-decision", limit: 50 })).events;
    expect(
      events.some(
        (event) =>
          (event.detail as { malformedControlRow?: unknown } | undefined)?.malformedControlRow === true,
      ),
    ).toBe(true);
  });
});

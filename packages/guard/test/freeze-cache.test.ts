import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

/**
 * The kill switch is one static row read three times per tool call. Check-time
 * reads may serve a ~10s cached answer; the pre-execute gate never may — a
 * freeze that lands while the judge is thinking still has to refuse the
 * dispatch. Both halves are asserted here against the REAL store, with the flag
 * flipped the way the console flips it (a write straight through the store,
 * from another process — which is exactly the flip an in-process cache cannot
 * hear about).
 */

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

/** The console's own write path for the flag. */
function freezeRow(sqlStore: PGliteStore, frozen: boolean): Promise<unknown> {
  return sqlStore.records("guard:controls").put({
    id: "freeze",
    data: { frozen, by: "console", at: new Date().toISOString() },
  });
}

/** The same store, counting the reads of the freeze row. */
function counting(sqlStore: PGliteStore): { store: PGliteStore; reads: () => number } {
  let reads = 0;
  const wrapped = new Proxy(sqlStore, {
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
            const value = Reflect.get(innerTarget, innerProp, innerReceiver);
            if (innerProp !== "get") return typeof value === "function" ? value.bind(innerTarget) : value;
            return async (id: string) => {
              reads += 1;
              return await (value as (id: string) => Promise<unknown>).call(innerTarget, id);
            };
          },
        });
      };
    },
  });
  return { store: wrapped, reads: () => reads };
}

describe("the freeze flag, cached at check time and fresh at the gate", () => {
  it("serves a check-time read from the cache while the pre-execute gate still reads the store", async () => {
    const sqlStore = await store();
    const counted = counting(sqlStore);
    const guard = createGuard({ store: counted.store });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_cached");

    // One tool call: the check reads the row, the pre-execute gate reads it again.
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });
    expect(counted.reads()).toBe(2);

    // A second check within the TTL asks the store nothing — the answer it has
    // is at most 10 seconds old, which is the accepted staleness for a
    // DECISION (the gate below is what a freeze actually has to beat).
    const cached = counted.reads();
    await expect(guard.check(read, descriptor("read"), context())).resolves.toMatchObject({
      action: "run",
    });
    expect(counted.reads()).toBe(cached);
  });

  it("refuses the dispatch when the freeze lands during the judge's window", async () => {
    const sqlStore = await store();
    const counted = counting(sqlStore);
    // The judge is the check's long await (up to 15s in the field). Freezing
    // from inside it is that window, deterministically: the check read the flag
    // before this ran, so only the pre-execute re-read can see the freeze.
    const guard = createGuard({
      store: counted.store,
      judge: {
        decide: async () => {
          await freezeRow(sqlStore, true);
          return { action: "run", rationale: "cleared before the freeze landed" };
        },
      },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const write = call("host_write", { invoiceId: "inv_1" }, "call_judged");

    await expect(bound.execute(write, context())).resolves.toMatchObject({
      status: "blocked",
      reason: "vendo is frozen — nothing runs until it is unfrozen",
    });
    // The tool never ran, and the gate paid for a real read to find that out.
    expect(tools.executions).toHaveLength(0);
    expect(counted.reads()).toBe(2);
  });
});

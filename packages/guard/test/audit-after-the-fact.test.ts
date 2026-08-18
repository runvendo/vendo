/**
 * The tool-call audit row is written AFTER the tool ran and nothing downstream
 * reads it, so the caller must not wait on the store round trip that persists
 * it. What has to stay true is that the row still lands, in order, and that a
 * reader can settle the writes deterministically — `flush()` for a raw-SQL
 * reader, and `audit.query` for anyone reading the trail through the guard.
 */
import type { RecordInput } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { call, context, FixtureTools } from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

/** The same store with every `vendo_audit` write parked until the test
 *  releases it — the only way to observe whether a tool call waits for its own
 *  audit row, without a sleep or a poll. */
function heldAudit(target: PGliteStore): { store: PGliteStore; release: () => void } {
  const held: Array<() => void> = [];
  const proxied = new Proxy(target, {
    get(source, prop, receiver) {
      if (prop !== "records") {
        const value = Reflect.get(source, prop, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      }
      return (collection: string) => {
        const inner = source.records(collection);
        if (collection !== "vendo_audit") return inner;
        return new Proxy(inner, {
          get(innerSource, innerProp, innerReceiver) {
            const value = Reflect.get(innerSource, innerProp, innerReceiver);
            if (innerProp !== "put") return typeof value === "function" ? value.bind(innerSource) : value;
            return async (record: RecordInput) => {
              await new Promise<void>((resolve) => held.push(resolve));
              return (value as (input: RecordInput) => Promise<unknown>).call(innerSource, record);
            };
          },
        });
      };
    },
  });
  return {
    store: proxied,
    release: () => {
      for (const resume of held.splice(0)) resume();
    },
  };
}

describe("the tool-call audit row is written after the fact", () => {
  it("returns the tool's outcome while the audit write is still in flight, and flush() settles it", async () => {
    const sqlStore = await store();
    const audit = heldAudit(sqlStore);
    const guard = createGuard({ store: audit.store });
    const bound = guard.bind(new FixtureTools());

    // The audit write cannot complete until `release()`; the call resolves anyway.
    await expect(bound.execute(call("host_read", {}, "call_after_the_fact"), context()))
      .resolves.toMatchObject({ status: "ok" });

    audit.release();
    await guard.flush();

    const rows = await sqlStore.query<{ tool: string | null; outcome: string | null }>(
      `SELECT tool, event->>'outcome' AS outcome FROM vendo_audit WHERE kind = 'tool-call'`,
    );
    expect(rows.rows).toEqual([{ tool: "host_read", outcome: "ok" }]);
  });

  it("keeps the guard's own read of the trail deterministic — audit.query settles the writes first", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(new FixtureTools());

    await bound.execute(call("host_read", {}, "call_query_settles"), context());

    const events = (await guard.audit.query({ limit: 50 })).events;
    expect(events.filter((event) => event.kind === "tool-call").map((event) => event.tool))
      .toEqual(["host_read"]);
  });
});

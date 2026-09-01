/**
 * The contract of `emptySharedStore()`, which ~90 test files now build on.
 *
 * Written because the sweep that introduced it shipped one vacuous test: two
 * `emptySharedStore()` calls in `turn/serve.test.ts` looked like two stores and
 * were one, so three assertions about which store a parked card landed in could
 * not fail. The engine identity rules below are exactly the ones that would have
 * caught it, and the reset rules are what let a shared engine stand in for a
 * fresh one at all.
 */
import { describe, expect, it } from "vitest";
import { postgresAppDatabase } from "../../src/store/app-database.js";
import { emptySharedStore } from "../../src/store/backends.test-util.js";
import type { VendoStore } from "../../src/store/index.js";

const slots = (store: VendoStore) => store.records("vendo_placement_slots");

const raw = (store: VendoStore): { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> } =>
  store.raw() as { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };

const appSchemas = async (store: VendoStore): Promise<string[]> =>
  (await raw(store).query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vendo\\_app\\_%' ORDER BY nspname",
  )).rows.map((row) => row.nspname);

describe("emptySharedStore — engine identity", () => {
  it("unnamed twice is ONE engine: the second call is the first store again", async () => {
    // The trap. A test that reads this as "two stores" is asserting isolation
    // against itself, and no product change can make it fail.
    expect(await emptySharedStore()).toBe(await emptySharedStore());
  });

  it("a NAMED engine is a different database — a write through one is invisible to the other", async () => {
    const mine = await emptySharedStore();
    const theirs = await emptySharedStore({ engine: "neighbour" });

    expect(theirs).not.toBe(mine);
    await slots(mine).put({ id: "slot_1", data: { whose: "mine" } });
    await slots(theirs).put({ id: "slot_1", data: { whose: "theirs" } });

    // Same id in both, and neither reads the other's row.
    expect((await slots(mine).get("slot_1"))?.data).toEqual({ whose: "mine" });
    expect((await slots(theirs).get("slot_1"))?.data).toEqual({ whose: "theirs" });
  });

  it("the same name comes back to the same engine, and resetting one leaves the other alone", async () => {
    const mine = await emptySharedStore();
    await slots(mine).put({ id: "slot_keep", data: { ok: true } });

    const theirs = await emptySharedStore({ engine: "neighbour" });
    expect(theirs).toBe(await emptySharedStore({ engine: "neighbour" }));
    // `theirs` was acquired — and reset — twice while `mine` held a row.
    expect((await slots(mine).get("slot_keep"))?.data).toEqual({ ok: true });
  });
});

describe("emptySharedStore — the reset stands in for a fresh store", () => {
  it("every public row a test wrote is gone", async () => {
    const first = await emptySharedStore({ engine: "reset" });
    await slots(first).put({ id: "slot_gone", data: { ok: true } });

    const second = await emptySharedStore({ engine: "reset" });

    expect(second).toBe(first);
    expect((await slots(second).list()).records).toEqual([]);
  });

  it("the per-app schemas app-database.ts creates on demand are dropped with them", async () => {
    // These live outside `public`, so a TRUNCATE over public never reached them
    // and an app database outlived the test that made it.
    const store = await emptySharedStore({ engine: "app-schemas" });
    const apps = postgresAppDatabase(store);
    if (apps === undefined) throw new Error("expected a SQL-backed app database");
    await apps.run("app_contract", [
      { sql: "CREATE TABLE notes (id text primary key)" },
      { sql: "INSERT INTO notes VALUES ('n1')" },
    ]);
    // Name matched by prefix: `appSchema()` appends a digest so two app ids that
    // sanitise alike cannot share a schema, and that digest is not this test's
    // business — its existence, and then its absence, is.
    expect(await appSchemas(store)).toHaveLength(1);
    expect((await appSchemas(store))[0]).toMatch(/^vendo_app_app_contract/u);

    await emptySharedStore({ engine: "app-schemas" });

    expect(await appSchemas(store)).toEqual([]);
    // ...and the store is still usable afterwards, schema and all.
    await slots(store).put({ id: "slot_after", data: { ok: true } });
    expect((await slots(store).list()).records).toHaveLength(1);
  });

  it("vendo_meta SURVIVES: the schema version is what a freshly-ensured store also carries", async () => {
    // Clearing it would send the next `ensureSchema()` through every migration
    // again, which is the opposite of standing in for a store that is ready.
    const store = await emptySharedStore({ engine: "meta" });
    const version = async (): Promise<unknown> =>
      (await raw(store).query<{ value: unknown }>(
        "SELECT value FROM vendo_meta WHERE key = 'schema_version'",
      )).rows[0]?.value;

    const before = await version();
    expect(before).toBeDefined();

    await emptySharedStore({ engine: "meta" });

    expect(await version()).toEqual(before);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db.js";

interface Engine {
  name: "pglite" | "postgres";
  makeDb(): Db;
}

const url = process.env.POSTGRES_URL;
const engines: Engine[] = [
  { name: "pglite", makeDb: () => createDb({ dataDir: `memory://tx-test-${Date.now()}` }) },
];
if (url) {
  engines.push({ name: "postgres", makeDb: () => createDb({ url }) });
} else {
  console.info("POSTGRES_URL not set — postgres leg skipped");
}

// The pg engine owns its own transaction lifecycle (dedicated pool client,
// BEGIN/COMMIT/ROLLBACK, release) separate from PGlite's, so the same
// assertions run on both; db-postgres.transaction.test.ts covers the pg
// client wiring without a server.
describe.each(engines)("Db.transaction() on $name", ({ makeDb }) => {
  let db: Db;

  beforeEach(async () => {
    db = makeDb();
    await db.query("DROP TABLE IF EXISTS tx_test");
    await db.query("CREATE TABLE tx_test (id text PRIMARY KEY, val text)");
  });

  afterEach(async () => {
    await db.query("DROP TABLE IF EXISTS tx_test");
    await db.close();
  });

  it("commits on success", async () => {
    await db.transaction(async (query) => {
      await query("INSERT INTO tx_test (id, val) VALUES ($1, $2)", ["a", "1"]);
    });
    const result = await db.query("SELECT val FROM tx_test WHERE id = $1", ["a"]);
    expect(result.rows[0]?.val).toBe("1");
  });

  it("rolls back on error", async () => {
    await expect(
      db.transaction(async (query) => {
        await query("INSERT INTO tx_test (id, val) VALUES ($1, $2)", ["b", "2"]);
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");
    const result = await db.query("SELECT val FROM tx_test WHERE id = $1", ["b"]);
    expect(result.rows).toHaveLength(0);
  });

  it("returns the work function result", async () => {
    const result = await db.transaction(async (query) => {
      await query("INSERT INTO tx_test (id, val) VALUES ($1, $2)", ["c", "3"]);
      return 42;
    });
    expect(result).toBe(42);
  });

  it("runs beforeWork hook after BEGIN", async () => {
    const order: string[] = [];
    await db.transaction(
      async (query) => {
        order.push("work");
        await query("INSERT INTO tx_test (id, val) VALUES ($1, $2)", ["d", "4"]);
      },
      {
        beforeWork: async (_query) => {
          order.push("beforeWork");
        },
      },
    );
    expect(order).toEqual(["beforeWork", "work"]);
    const result = await db.query("SELECT val FROM tx_test WHERE id = $1", ["d"]);
    expect(result.rows[0]?.val).toBe("4");
  });

  it("beforeWork runs inside the transaction — SET LOCAL is visible to work", async () => {
    // SET LOCAL only takes effect inside an open transaction, so work seeing
    // the value proves beforeWork ran after BEGIN (the RLS tenant-context
    // pattern this hook exists for).
    const seen = await db.transaction(
      async (query) => {
        const result = await query("SELECT current_setting('vendo.tenant', true) AS tenant");
        return result.rows[0]?.tenant;
      },
      {
        beforeWork: async (query) => {
          await query("SET LOCAL vendo.tenant = 'tenant_1'");
        },
      },
    );
    expect(seen).toBe("tenant_1");
  });

  it("rolls back if beforeWork throws", async () => {
    await expect(
      db.transaction(
        async (query) => {
          await query("INSERT INTO tx_test (id, val) VALUES ($1, $2)", ["e", "5"]);
        },
        {
          beforeWork: async () => {
            throw new Error("hook failure");
          },
        },
      ),
    ).rejects.toThrow("hook failure");
    const result = await db.query("SELECT val FROM tx_test WHERE id = $1", ["e"]);
    expect(result.rows).toHaveLength(0);
  });

  it("rejects after close() without running work", async () => {
    // Fresh handle: the shared `db` is torn down in afterEach, which still
    // needs to query it.
    const fresh = makeDb();
    await fresh.close();
    let workRan = false;
    await expect(
      fresh.transaction(async () => {
        workRan = true;
      }),
    ).rejects.toThrow("[vendo] store is closed");
    expect(workRan).toBe(false);
  });
});

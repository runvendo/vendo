import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./db.js";

describe("Db.transaction()", () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb({ dataDir: `memory://tx-test-${Date.now()}` });
    await db.query("CREATE TABLE IF NOT EXISTS tx_test (id text PRIMARY KEY, val text)");
  });

  afterEach(async () => {
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
});

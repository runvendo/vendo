import { describe, expect, it, vi } from "vitest";

/** The pg engine's transaction lifecycle — dedicated pool client, BEGIN,
 *  beforeWork, work, COMMIT/ROLLBACK, release — is separate code from PGlite's,
 *  so this seam suite pins its client wiring without needing a server; the
 *  POSTGRES_URL leg of db.transaction.test.ts covers it end-to-end. */

interface FakeClient {
  calls: string[];
  released: number;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

const state = vi.hoisted(() => ({
  clients: [] as { calls: string[]; released: number }[],
  poolQueries: [] as string[],
}));

vi.mock("pg", () => {
  class Pool {
    on() {}
    async end() {}
    async query(text: string) {
      state.poolQueries.push(text);
      return { rows: [] };
    }
    async connect(): Promise<FakeClient> {
      const client: FakeClient = {
        calls: [],
        released: 0,
        async query(text: string) {
          client.calls.push(text);
          return { rows: [] };
        },
        release() {
          client.released += 1;
        },
      };
      state.clients.push(client);
      return client;
    }
  }
  class Client {}
  return { Pool, Client };
});

import { createPostgresDb } from "./db-postgres.js";

const lastClient = () => state.clients[state.clients.length - 1]!;

describe("createPostgresDb transaction lifecycle", () => {
  it("runs BEGIN, beforeWork, work, COMMIT on one dedicated client and releases it", async () => {
    const db = createPostgresDb("postgres://never-connected");
    const before = state.clients.length;
    const result = await db.transaction(
      async (query) => {
        await query("SELECT 1");
        return 42;
      },
      {
        beforeWork: async (query) => {
          await query("SET LOCAL vendo.tenant = 'tenant_1'");
        },
      },
    );
    expect(result).toBe(42);
    expect(state.clients.length).toBe(before + 1);
    expect(lastClient().calls).toEqual(["BEGIN", "SET LOCAL vendo.tenant = 'tenant_1'", "SELECT 1", "COMMIT"]);
    expect(lastClient().released).toBe(1);
    // Transaction statements must never ride the shared pool — they would
    // land on arbitrary connections and silently autocommit.
    expect(state.poolQueries).toEqual([]);
  });

  it("rolls back and releases the client when work throws", async () => {
    const db = createPostgresDb("postgres://never-connected");
    await expect(
      db.transaction(async (query) => {
        await query("SELECT 1");
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");
    expect(lastClient().calls).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
    expect(lastClient().released).toBe(1);
  });

  it("rolls back before work runs and releases the client when beforeWork throws", async () => {
    const db = createPostgresDb("postgres://never-connected");
    let workRan = false;
    await expect(
      db.transaction(
        async () => {
          workRan = true;
        },
        {
          beforeWork: async () => {
            throw new Error("hook failure");
          },
        },
      ),
    ).rejects.toThrow("hook failure");
    expect(workRan).toBe(false);
    expect(lastClient().calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(lastClient().released).toBe(1);
  });

  it("rejects after close() without acquiring a client or running work", async () => {
    const db = createPostgresDb("postgres://never-connected");
    await db.close();
    const before = state.clients.length;
    let workRan = false;
    await expect(
      db.transaction(async () => {
        workRan = true;
      }),
    ).rejects.toThrow("[vendo] store is closed");
    expect(workRan).toBe(false);
    expect(state.clients.length).toBe(before);
  });
});

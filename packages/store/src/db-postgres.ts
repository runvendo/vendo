/** Postgres-only half of the store's Db seam (02-store §4). This module — and
 *  everything it reaches — must stay free of PGlite: it is the entire engine
 *  graph of the `@vendoai/store/postgres` entry, which exists so consumers on
 *  a real Postgres (serverless bundles especially) never carry the wasm
 *  engine they can't run. The PGlite dev-mode default layers on top of this
 *  module in ./db.ts. Enforced by scripts/portability-gate.mjs. */
import { Client, Pool } from "pg";
import { log } from "@vendoai/core";

/** 02-store §1 */
export interface StoreConfig {
  url?: string;
  dataDir?: string;
  encryption?: { key: string };
  /** 02-store §4 — dev-mode escape hatch: store secrets unencrypted when no
      encryption key is configured. Never enable in production; secret writes
      without a key fail closed there. */
  allowUnencryptedSecrets?: boolean;
}

export type Query = Db["query"];

/** A data directory the next redeploy deletes, and why: a container platform
    that wipes its filesystem (named), or a path under the OS temp dir (no
    platform). Composed state, not a message — whoever holds the store decides
    how to say it; `createVendo` renders it as the boot block's ⚠ store row. */
export interface EphemeralDataDir {
  /** The directory as configured — what the operator wrote, or the default. */
  readonly dataDir: string;
  /** The platform whose filesystem is wiped, when a marker named one. */
  readonly platform?: string;
}

/** 02-store §4 */
export interface Db {
  kind: "pg" | "pglite";
  /** Set only when this engine writes to storage a redeploy wipes — the PGlite
      default on a container platform or under the OS temp dir. Absent for a
      Postgres url, for `memory://`, and for a real disk. */
  readonly ephemeral?: EphemeralDataDir;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
  raw(): unknown;
  /** 02-store §4 — serialize schema migration against concurrent migrators.
      Lives on the handle (not as a free function) so schema.ts needs no
      driver import: the pg implementation must open a dedicated session for
      the advisory lock, and pulling `pg` into the shared modules would drag
      it into every entry's bundle graph. */
  withSchemaLock<T>(work: (query: Query) => Promise<T>): Promise<T>;
  /** Run work inside a database transaction. The callback receives a
   *  transaction-scoped query function; commit on success, rollback on throw.
   *  Accepts an optional `beforeWork` hook that runs AFTER BEGIN but BEFORE the
   *  callback — designed for SET LOCAL statements (RLS tenant context in task 12). */
  transaction<T>(
    work: (query: Query) => Promise<T>,
    opts?: { beforeWork?: (query: Query) => Promise<void> },
  ): Promise<T>;
}

const ADVISORY_LOCK_KEY = 7_461_001;

/** The pg engine: a lazy Pool for queries, a dedicated Client per schema
 *  lock (advisory locks are session-scoped). */
export function createPostgresDb(url: string): Db {
  const pool = new Pool({ connectionString: url });
  pool.on("error", (error) => {
    log({
      code: "store.postgres-pool-error",
      level: "error",
      message: "[vendo] postgres pool: idle connection error (recovering)",
      data: { error },
    });
  });
  let closed = false;
  return {
    kind: "pg",
    async query(text, params = []) {
      if (closed) throw new Error("[vendo] store is closed");
      const result = await pool.query(text, params);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
    raw() {
      if (closed) throw new Error("[vendo] store is closed");
      return pool;
    },
    withSchemaLock(work) {
      return withAdvisoryLock(url, ADVISORY_LOCK_KEY, work);
    },
    async transaction(work, opts) {
      if (closed) throw new Error("[vendo] store is closed");
      const client = await pool.connect();
      const txQuery: Query = async (text, params = []) => {
        const result = await client.query(text, params);
        return { rows: result.rows as Record<string, unknown>[] };
      };
      try {
        await txQuery("BEGIN");
        if (opts?.beforeWork) await opts.beforeWork(txQuery);
        const result = await work(txQuery);
        await txQuery("COMMIT");
        return result;
      } catch (error) {
        await txQuery("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function withAdvisoryLock<T>(url: string, key: number, work: (query: Query) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  const query: Query = async (text, params = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  try {
    await query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await work(query);
    } finally {
      await query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    await client.end();
  }
}

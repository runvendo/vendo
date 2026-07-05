import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export interface FlowletDatabaseConfig {
  connectionString?: string;
  pglite?: { dataDir: string };
}

export type FlowletDb =
  | { kind: "pglite"; db: ReturnType<typeof drizzlePglite>; cacheKey: string }
  | { kind: "pg"; db: ReturnType<typeof drizzlePg>; cacheKey: string };

const SERVERLESS_ENVS = ["VERCEL", "CF_PAGES", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const ADVISORY_LOCK_KEY = 7461001;

interface Registry {
  instances: Map<string, Promise<FlowletDb>>;
  migrated: Map<string, Promise<void>>;
}
const registry: Registry = ((globalThis as Record<string, unknown>)["__flowletStoreRegistry"] ??= {
  instances: new Map(),
  migrated: new Map(),
}) as Registry;

export function createFlowletDatabase(config: FlowletDatabaseConfig = {}): Promise<FlowletDb> {
  // `||` (not `??`): a set-but-empty DATABASE_URL means "no connection string",
  // and must not become a shared "" cache key across different PGlite dirs.
  const conn = config.connectionString || process.env["DATABASE_URL"] || undefined;
  const dataDir = config.pglite?.dataDir ?? process.env["FLOWLET_DATA_DIR"] ?? ".flowlet/data";
  const cacheKey = conn ?? `pglite:${dataDir}`;
  const existing = registry.instances.get(cacheKey);
  if (existing) return existing;

  const created: Promise<FlowletDb> = (async () => {
    if (conn) return { kind: "pg" as const, db: drizzlePg(new Pool({ connectionString: conn })), cacheKey };
    const onServerless = SERVERLESS_ENVS.find((e) => process.env[e]);
    if (onServerless) {
      throw new Error(
        `[flowlet] PGlite (the zero-config store) cannot run on ${onServerless} — filesystems there are ephemeral. ` +
          `Set DATABASE_URL to a hosted Postgres (Supabase, Neon, …) instead.`,
      );
    }
    if (!dataDir.startsWith("memory://")) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.accessSync(dataDir, fs.constants.W_OK);
      } catch (err) {
        // Fail boot loudly — never fall back to a silent ephemeral store.
        throw new Error(
          `[flowlet] PGlite data directory "${dataDir}" is not writable — ` +
            `fix its permissions or point FLOWLET_DATA_DIR elsewhere. Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const client = await PGlite.create(dataDir);
    return { kind: "pglite" as const, db: drizzlePglite(client), cacheKey };
  })();
  created.catch(() => registry.instances.delete(cacheKey)); // failed boots retry
  registry.instances.set(cacheKey, created);
  return created;
}

/** Idempotent, race-safe (advisory lock on real PG), memoized per handle. */
export function migrateFlowletDatabase(handle: FlowletDb): Promise<void> {
  const memo = registry.migrated.get(handle.cacheKey);
  if (memo) return memo;
  const run = (async () => {
    if (handle.kind === "pglite") {
      await migratePglite(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
      return;
    }
    await handle.db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    try {
      await migratePg(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
    } finally {
      await handle.db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  })().catch((err) => {
    throw new Error(
      `[flowlet] migration failed — if this is a permissions error, grant the role CREATE on the database ` +
        `or run migrations out-of-band (autoMigrate: false + migrateFlowletDatabase). Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  run.catch(() => registry.migrated.delete(handle.cacheKey));
  registry.migrated.set(handle.cacheKey, run);
  return run;
}

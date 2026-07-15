import { PGlite } from "@electric-sql/pglite";
import { Client, Pool } from "pg";
import fs from "node:fs";

/** 02-store §1 */
export interface StoreConfig {
  url?: string;
  dataDir?: string;
  encryption?: { key: string };
}

/** 02-store §4 */
export interface Db {
  kind: "pg" | "pglite";
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
  raw(): unknown;
}

type Driver = Pool | PGlite;
type Query = Db["query"];

const SERVERLESS_ENVS = ["VERCEL", "CF_PAGES", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const ADVISORY_LOCK_KEY = 7_461_001;
const pgUrls = new WeakMap<Db, string>();

function preparePgliteDir(dataDir: string): void {
  if (dataDir.startsWith("memory://")) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vendo] PGlite data directory "${dataDir}" is not writable — fix its permissions or choose another dataDir. Cause: ${cause}`,
    );
  }
}

/** 02-store §4 */
export function createDb(config: StoreConfig = {}): Db {
  const kind = config.url ? "pg" : "pglite";
  const dataDir = config.dataDir ?? ".vendo/data";
  let driver: Driver | undefined;
  let opening: Promise<Driver> | undefined;
  let closed = false;

  if (config.url) {
    const pool = new Pool({ connectionString: config.url });
    pool.on("error", (error) => {
      console.error("[vendo] postgres pool: idle connection error (recovering)", error);
    });
    driver = pool;
  }

  const open = (): Promise<Driver> => {
    if (closed) return Promise.reject(new Error("[vendo] store is closed"));
    if (driver) return Promise.resolve(driver);
    if (opening) return opening;

    opening = (async () => {
      const serverlessEnv = SERVERLESS_ENVS.find((name) => process.env[name]);
      if (serverlessEnv) {
        throw new Error(
          `[vendo] PGlite cannot run on ${serverlessEnv} because its filesystem is ephemeral. Set a Postgres url instead.`,
        );
      }
      preparePgliteDir(dataDir);
      const pglite = await PGlite.create(dataDir);
      driver = pglite;
      return pglite;
    })();
    opening.catch(() => {
      if (!closed) opening = undefined;
    });
    return opening;
  };

  const db: Db = {
    kind,
    async query(text, params = []) {
      const active = await open();
      const result = active instanceof Pool
        ? await active.query(text, params)
        : await active.query<Record<string, unknown>>(text, params);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!opening && !driver) return;
      const active = driver ?? (opening ? await opening : undefined);
      if (!active) return;
      if (active instanceof Pool) await active.end();
      else await active.close();
      driver = undefined;
    },
    raw() {
      if (!driver) {
        throw new Error("[vendo] store not opened yet — run ensureSchema() or any query first");
      }
      return driver;
    },
  };

  if (config.url) pgUrls.set(db, config.url);
  return db;
}

/** 02-store §4 */
export async function withSchemaLock<T>(db: Db, work: (query: Query) => Promise<T>): Promise<T> {
  return withAdvisoryLock(db, [ADVISORY_LOCK_KEY], work);
}

/** ENG-263 — the classroom of the org-membership lock. A session-scoped Postgres
    advisory lock, taken on a dedicated pinned client so the whole `work` runs
    against the connection that holds it (the shared pool would scatter the
    lock/work/unlock across connections). PGlite serializes every query on one
    connection, so the lock is a no-op there. Keyed per resource so unrelated
    resources never block each other. */
const ORG_MEMBERSHIP_LOCK_NAMESPACE = 7_461_002;

/** Stable 31-bit hash of a resource id → the second int4 of a two-key advisory
    lock (the first is a namespace so org locks never collide with other lock
    users). Same id → same lock; collisions only cost extra serialization. */
function lockKeyForId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (Math.imul(31, hash) + id.charCodeAt(index)) | 0;
  }
  return hash & 0x7fffffff;
}

/** Serialize owner-set mutations for ONE org (03-store): demote/remove check
    the owner count then write, which races under READ COMMITTED (two owners
    each see the other and both commit → zero owners). Under this lock the two
    paths run one at a time per org, so the count the guard reads is the count
    the write sees. */
export async function withOrgMembershipLock<T>(db: Db, orgId: string, work: (query: Query) => Promise<T>): Promise<T> {
  return withAdvisoryLock(db, [ORG_MEMBERSHIP_LOCK_NAMESPACE, lockKeyForId(orgId)], work);
}

async function withAdvisoryLock<T>(db: Db, keys: [number] | [number, number], work: (query: Query) => Promise<T>): Promise<T> {
  if (db.kind === "pglite") return work(db.query.bind(db));

  const url = pgUrls.get(db);
  if (!url) throw new Error("[vendo] missing Postgres connection string");
  const client = new Client({ connectionString: url });
  await client.connect();
  const query: Query = async (text, params = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  try {
    await query(`SELECT pg_advisory_lock(${placeholders})`, keys);
    try {
      return await work(query);
    } finally {
      await query(`SELECT pg_advisory_unlock(${placeholders})`, keys);
    }
  } finally {
    await client.end();
  }
}

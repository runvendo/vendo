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
  if (db.kind === "pglite") return work(db.query.bind(db));

  const url = pgUrls.get(db);
  if (!url) throw new Error("[vendo] missing Postgres connection string");
  const client = new Client({ connectionString: url });
  await client.connect();
  const query: Query = async (text, params = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  try {
    await query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      return await work(query);
    } finally {
      await query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

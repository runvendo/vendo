import { PGlite } from "@electric-sql/pglite";
import { Client, Pool } from "pg";
import fs from "node:fs";
import { join } from "node:path";

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

/** ENG-350 — a dev server killed uncleanly leaves postmaster.pid in the data
    dir, and PGlite.create can then hard-abort with a raw `Aborted()`
    (electric-sql/pglite#2, #794). PGlite's wasm postgres always records
    Emscripten's fake pid (-42), so a non-positive or unparseable pid can never
    belong to a live owner — stale by definition. A real positive pid (a native
    postgres dir, or a custom writer) is only stale once that process is gone. */
function readPgliteLock(dataDir: string): { path: string; livePid?: number } | undefined {
  if (dataDir.startsWith("memory://")) return undefined;
  const lockPath = join(dataDir, "postmaster.pid");
  let firstLine: string;
  try {
    firstLine = fs.readFileSync(lockPath, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return undefined; // no lock file — nothing to heal
  }
  const pid = Number.parseInt(firstLine.trim(), 10);
  if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) return { path: lockPath, livePid: pid };
  return { path: lockPath };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = exists but owned by someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** ENG-350 — self-heal a stale lock instead of hard-aborting boot. */
async function createPgliteHealingStaleLock(dataDir: string): Promise<PGlite> {
  try {
    return await PGlite.create(dataDir);
  } catch (error) {
    const lock = readPgliteLock(dataDir);
    if (!lock) throw error;
    if (lock.livePid !== undefined) {
      throw new Error(
        `[vendo] PGlite data directory "${dataDir}" is locked by a live process (pid ${lock.livePid}) — stop that process or point dataDir elsewhere. Cause: ${errorMessage(error)}`,
      );
    }
    console.warn(
      `[vendo] PGlite data directory "${dataDir}" failed to open with a stale postmaster.pid left by an unclean shutdown — removing the stale lock and retrying.`,
    );
    fs.rmSync(lock.path, { force: true });
    try {
      return await PGlite.create(dataDir);
    } catch (retryError) {
      throw new Error(
        `[vendo] PGlite data directory "${dataDir}" failed to open even after clearing its stale lock — the store is likely corrupt. Back up and delete the directory to start fresh, or set a Postgres url. Cause: ${errorMessage(retryError)}`,
      );
    }
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
      const pglite = await createPgliteHealingStaleLock(dataDir);
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
  return withAdvisoryLock(db, ADVISORY_LOCK_KEY, work);
}

async function withAdvisoryLock<T>(db: Db, key: number, work: (query: Query) => Promise<T>): Promise<T> {
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

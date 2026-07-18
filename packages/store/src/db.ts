import { PGlite } from "@electric-sql/pglite";
import { Client, Pool } from "pg";
import fs from "node:fs";
import { join, resolve } from "node:path";

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

/* ENG-351 — single-writer discipline for the PGlite default.

   Under `next dev` the host's server module graph is evaluated by more than
   one OS process (Turbopack spawns transient evaluator workers) and, after an
   HMR edit, more than once within one process. Each evaluation runs
   `createVendo` → `createStore` → PGlite on the SAME data dir. PGlite has no
   cross-process locking, and even a second instance's STARTUP (WAL recovery,
   pg_control writes) tears the live writer's state — the dir later reopens
   with a raw `Aborted()` and the last turns are gone (ENG-351's field trace).

   Two layers, both keyed by the resolved data dir:
   - In-process: a globalThis registry shares ONE live driver across every
     handle (and every HMR copy of this module), refcounted so closing one
     handle never tears the driver out from under another.
   - Cross-process: a `<dataDir>/.vendo-writer.lock` pidfile taken BEFORE
     PGlite.create. A second process WAITS (it never touches postgres files)
     and takes over only once the holder is provably gone — recorded pid dead,
     or the holder's mtime refresh stopped long ago (pid-reuse fallback). Lock
     release rides close(); a SIGKILLed holder self-heals via the dead-pid
     check, which is also what makes the ENG-350 postmaster.pid heal safe:
     only the lock holder ever reaches it. */

const LOCK_TOUCH_MS = 5_000;
const LOCK_STALE_MTIME_MS = 30_000;
const LOCK_POLL_MS = 250;
const LOCK_WARN_AFTER_MS = 5_000;
const LOCK_REWARN_EVERY_MS = 60_000;

interface DirLock {
  release(): void;
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").split("\n", 1)[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The holder is provably gone: its recorded pid is dead, it recorded THIS
    process (a crashed predecessor with our reused pid — a live foreign holder
    can never be us), or it stopped refreshing the lock's mtime long ago. */
function lockIsStale(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid !== undefined && (pid === process.pid || !isPidAlive(pid))) return true;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MTIME_MS;
  } catch {
    return false; // vanished — the acquire loop just retries
  }
}

async function acquirePgliteDirLock(dataDir: string): Promise<DirLock> {
  const lockPath = join(resolve(dataDir), ".vendo-writer.lock");
  const startedAt = Date.now();
  let warnedAt: number | undefined;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `[vendo] cannot create the PGlite lock file "${lockPath}" — fix permissions on its directory or choose another dataDir. Cause: ${errorMessage(error)}`,
        );
      }
    }
    if (lockIsStale(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      continue; // re-race the wx create; exactly one contender wins
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= LOCK_WARN_AFTER_MS && (warnedAt === undefined || Date.now() - warnedAt >= LOCK_REWARN_EVERY_MS)) {
      warnedAt = Date.now();
      console.warn(
        `[vendo] PGlite data directory "${dataDir}" is held by another process (pid ${readLockPid(lockPath) ?? "unknown"}) — waiting for it to release the lock. If a second server runs on this dataDir, stop it or point it at its own dataDir / a Postgres url.`,
      );
    }
    await wait(LOCK_POLL_MS);
  }
  // Refresh mtime while held so waiters can tell a live holder from a
  // pid-reused ghost; unref'd so the lock never keeps the process alive.
  const touch = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      // Lock stolen or dir gone — nothing to refresh; release() still guards on pid.
    }
  }, LOCK_TOUCH_MS);
  touch.unref?.();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(touch);
      try {
        if (readLockPid(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
      } catch {
        // Best-effort: a leftover lock self-heals via the dead-pid check.
      }
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** One shared live PGlite per data dir per process, refcounted. Lives on
    globalThis (Symbol.for) so every HMR/bundle copy of this module shares it. */
interface SharedPglite {
  driver: Promise<PGlite>;
  lock?: DirLock;
  refs: number;
}

const PGLITE_REGISTRY_KEY = Symbol.for("vendoai.store.pglite-registry@1");

function pgliteRegistry(): Map<string, SharedPglite> {
  const holder = globalThis as { [PGLITE_REGISTRY_KEY]?: Map<string, SharedPglite> };
  return (holder[PGLITE_REGISTRY_KEY] ??= new Map());
}

function acquireSharedPglite(dataDir: string): SharedPglite {
  const registry = pgliteRegistry();
  const key = resolve(dataDir);
  let entry = registry.get(key);
  if (!entry) {
    const created: SharedPglite = { refs: 0, driver: Promise.resolve(undefined as never) };
    created.driver = (async () => {
      const lock = await acquirePgliteDirLock(dataDir);
      created.lock = lock;
      try {
        return await createPgliteHealingStaleLock(dataDir);
      } catch (error) {
        lock.release();
        throw error;
      }
    })();
    // A failed open must not poison the dir for later attempts.
    created.driver.catch(() => {
      if (registry.get(key) === created) registry.delete(key);
    });
    registry.set(key, created);
    entry = created;
  }
  entry.refs += 1;
  return entry;
}

async function releaseSharedPglite(dataDir: string, entry: SharedPglite): Promise<void> {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  const registry = pgliteRegistry();
  const key = resolve(dataDir);
  if (registry.get(key) === entry) registry.delete(key);
  const driver = await entry.driver.catch(() => undefined);
  try {
    await driver?.close();
  } finally {
    entry.lock?.release();
  }
}

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
  let shared: SharedPglite | undefined;
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
      // memory:// dirs are private to this handle; a real dir goes through the
      // shared single-writer registry (ENG-351).
      if (dataDir.startsWith("memory://")) {
        const pglite = await createPgliteHealingStaleLock(dataDir);
        driver = pglite;
        return pglite;
      }
      shared = acquireSharedPglite(dataDir);
      try {
        const pglite = await shared.driver;
        driver = pglite;
        return pglite;
      } catch (error) {
        const failed = shared;
        shared = undefined;
        await releaseSharedPglite(dataDir, failed);
        throw error;
      }
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
      const active = driver ?? (opening ? await opening.catch(() => undefined) : undefined);
      driver = undefined;
      if (shared) {
        // Shared PGlite: drop this handle's ref; the last one out closes the
        // wasm instance and releases the dir lock (ENG-351).
        const held = shared;
        shared = undefined;
        await releaseSharedPglite(dataDir, held);
        return;
      }
      if (!active) return;
      if (active instanceof Pool) await active.end();
      else await active.close();
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

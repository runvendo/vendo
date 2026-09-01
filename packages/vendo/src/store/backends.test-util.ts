import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { StoreConfig } from "./db.js";
import { createStore, type VendoStore } from "./index.js";

export interface MadeBackend {
  store: VendoStore;
  sql(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  url?: string;
  dataDir?: string;
  cleanup(): Promise<void>;
}

export interface Backend {
  name: "pglite" | "postgres";
  make(): Promise<MadeBackend>;
}

const pglite: Backend = {
  name: "pglite",
  async make() {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-store-"));
    let cleaned = false;
    const result: MadeBackend = {
      store: createStore({ dataDir }),
      dataDir,
      async sql(text, params = []) {
        const raw = result.store.raw() as { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };
        return (await raw.query<Record<string, unknown>>(text, params)).rows;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await result.store.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
    return result;
  },
};

/** A private schema per made backend, never the shared `public` one.
 *
 *  The whole monorepo's `pnpm test` can point at ONE Postgres — the release gate
 *  does exactly that (release.yml sets a single `vendo_test` for every package,
 *  at turbo concurrency 4) — and this backend used to give itself a clean slate
 *  by DROPping a hand-kept list of tables in `public`. That nuked the tables
 *  `fixtures/integration`'s J9 durability journey was reading mid-flight
 *  (`relation "vendo_apps" does not exist`), which took out a release run and
 *  v0.26.0's. So: carve a schema, point `search_path` at it, drop it whole.
 *
 *  `search_path` rides the connection string, so the store under test builds its
 *  own pool and advisory-lock client from it and lands every statement — the same
 *  unqualified SQL it ships — inside the schema. Same mechanic as
 *  `fixtures/mcp-e2e`'s token-claim race. Dropping the schema also cannot drift
 *  the way the list did: it had fallen two tables behind the DDL, so every run
 *  leaked `vendo_knowledge_docs`/`_chunks` into `public`. And the schema is empty
 *  by construction, so the clean slate the DROP used to buy comes free. */
const postgres = (url: string): Backend => ({
  name: "postgres",
  async make() {
    const schema = `vendo_store_${randomUUID().replaceAll("-", "")}`;
    const scoped = new URL(url);
    const priorOptions = scoped.searchParams.get("options");
    scoped.searchParams.set(
      "options",
      [priorOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
    );
    const scopedUrl = scoped.toString();

    // Connected before the schema exists, which is fine: `search_path` is
    // resolved per statement, and CREATE/DROP SCHEMA name it absolutely.
    const client = new Client({ connectionString: scopedUrl });
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA ${schema}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    let cleaned = false;
    const result: MadeBackend = {
      store: createStore({ url: scopedUrl }),
      url: scopedUrl,
      async sql(text, params = []) {
        return (await client.query(text, params)).rows as Record<string, unknown>[];
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await result.store.close();
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
        await client.end();
      },
    };
    return result;
  },
});

/** One PGlite store per file, handed back with everything a test wrote wiped.
 *
 *  A PGlite boot plus its migrations measures ~550ms, so a file that wants a
 *  pristine store per test used to pay ~550ms per test to prepare a database it
 *  then wrote five rows into. Emptying it gives the same starting state — schema
 *  present, no rows — for ~40ms, so the boot is paid once per file.
 *
 *  ONE HANDLE per engine, not one per call: `memory://` data dirs are private to
 *  their handle (db.ts), so callers on the same engine share a store, not just a
 *  database. Do not close it. A test that needs two stores at once that are
 *  genuinely independent must NAME the second engine — two names are two
 *  processes' worth of Postgres and cannot see each other, where two unnamed
 *  calls are the same store twice and would make an isolation assertion
 *  vacuously green.
 *
 *  `vendo_meta` is left alone: it holds the schema version and boot id, which a
 *  freshly-ensured store also carries, and clearing it would re-run every
 *  migration. Same table `erase.ts` exempts, for the same reason.
 *
 *  NOT for tests that prove store CREATION — a store with no schema yet,
 *  `ensureSchema` itself, closing or erasing the engine. Those want an engine of
 *  their own, which `backends().make()` still gives them. */
export async function emptySharedStore(
  options: Pick<StoreConfig, "encryption"> & {
    /** Which engine to hand back. Unset is the file's one engine; a name is a
     *  second, independent one, for the tests that hold two at once. */
    engine?: string;
  } = {},
): Promise<VendoStore> {
  // The engine name and the store config both key the map: a store's encryption
  // key is fixed at construction, so two keys cannot share a handle either.
  const { engine = "", ...config } = options;
  const key = `${engine} ${JSON.stringify(config)}`;
  let shared = sharedStores.get(key);
  if (!shared) {
    const dataDir = `memory://vendo-shared-test-store-${sharedStores.size}`;
    shared = (async () => {
      const store = createStore({ ...config, dataDir });
      await store.ensureSchema();
      return { store, raw: store.raw() as SharedStore["raw"] };
    })();
    sharedStores.set(key, shared);
  }
  const { store, raw } = await shared;
  await raw.query(EMPTY);
  return store;
}

/** Everything a test can leave behind, worked out WHEN it is wiped rather than
 *  once at boot: `vendo_apps`'s per-app databases each live in a schema of their
 *  own (`app-database.ts`), created on demand, so the set is not knowable until
 *  the run that created them is over. */
const EMPTY = `DO $$
DECLARE target text;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO target
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'vendo_meta';
  IF target IS NOT NULL THEN EXECUTE 'TRUNCATE ' || target || ' RESTART IDENTITY CASCADE'; END IF;
  FOR target IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vendo\\_app\\_%' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', target);
  END LOOP;
END $$`;

interface SharedStore {
  store: VendoStore;
  raw: { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };
}

const sharedStores = new Map<string, Promise<SharedStore>>();

/** One shared table shape on both supported backends. */
export function backends(): Backend[] {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.info("POSTGRES_URL not set — postgres leg skipped");
    return [pglite];
  }
  return [pglite, postgres(url)];
}

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
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

/** One shared table shape on both supported backends. */
export function backends(): Backend[] {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.info("POSTGRES_URL not set — postgres leg skipped");
    return [pglite];
  }
  return [pglite, postgres(url)];
}

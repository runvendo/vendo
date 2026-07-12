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

const TABLES = [
  "invoices",
  "vendo_secrets",
  "vendo_runs",
  "vendo_audit",
  "vendo_approvals",
  "vendo_grants",
  "vendo_threads",
  "vendo_state",
  "vendo_blobs",
  "vendo_records",
  "vendo_apps",
  "vendo_meta",
] as const;

const dropTables = async (client: Client): Promise<void> => {
  await client.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE`);
};

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

const postgres = (url: string): Backend => ({
  name: "postgres",
  async make() {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await dropTables(client);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    let cleaned = false;
    const result: MadeBackend = {
      store: createStore({ url }),
      url,
      async sql(text, params = []) {
        return (await client.query(text, params)).rows as Record<string, unknown>[];
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await result.store.close();
        await dropTables(client);
        await client.end();
      },
    };
    return result;
  },
});

/** One shared schema on both supported backends. */
export function backends(): Backend[] {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.info("POSTGRES_URL not set — postgres leg skipped");
    return [pglite];
  }
  return [pglite, postgres(url)];
}

import { VendoError } from "@vendoai/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { createStore } from "./index.js";

const CONTRACT_COLUMNS: Record<string, string[]> = {
  vendo_meta: ["key", "value"],
  vendo_apps: ["id", "subject", "enabled", "doc", "created_at", "updated_at"],
  vendo_records: ["collection", "id", "data", "refs", "created_at", "updated_at", "revision"],
  vendo_blobs: ["namespace", "key", "bytes", "content_type", "created_at"],
  vendo_state: ["app_id", "subject", "data", "updated_at"],
  vendo_threads: ["id", "subject", "messages", "created_at", "updated_at"],
  vendo_grants: ["id", "subject", "tool", "descriptor_hash", "scope", "duration", "app_id", "source", "granted_at", "revoked_at", "expires_at"],
  vendo_approvals: ["id", "subject", "request", "status", "decided_at", "created_at"],
  vendo_audit: ["id", "at", "kind", "subject", "venue", "presence", "app_id", "tool", "event"],
  vendo_runs: ["id", "app_id", "trigger", "status", "record", "started_at", "finished_at"],
  vendo_secrets: ["name", "ciphertext", "created_at"],
  vendo_mcp_clients: ["id", "data", "refs", "created_at", "updated_at"],
  vendo_mcp_grants: ["id", "data", "refs", "created_at", "updated_at"],
};

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("ensureSchema is idempotent", async () => {
      await made.store.ensureSchema();
      await made.store.ensureSchema();
      await made.store.ensureSchema();
    });

    it("stores schema_version and a boot_id in vendo_meta", async () => {
      const rows = await made.sql("SELECT key, value FROM vendo_meta ORDER BY key");
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "schema_version", value: 2 }),
        expect.objectContaining({ key: "boot_id" }),
      ]));
      expect(rows.find((row) => row.key === "boot_id")?.value).toEqual(expect.any(String));
    });

    it("lands a fresh database directly on schema version 2", async () => {
      // A brand-new DB never runs the v2 backfill's DELETE against real data; it
      // just records the current version. (beforeAll already ran ensureSchema.)
      const version = (await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value;
      expect(version).toBe(2);
    });

    it("keeps boot_id stable across a close and reopen", async () => {
      const before = (await made.sql("SELECT value FROM vendo_meta WHERE key = 'boot_id'"))[0]?.value;
      await made.store.close();
      const reopened = createStore({ url: made.url, dataDir: made.dataDir });
      await reopened.ensureSchema();
      made.store = reopened;
      const raw = reopened.raw() as { query<T>(text: string): Promise<{ rows: T[] }> };
      const after = (await raw.query<Record<string, unknown>>("SELECT value FROM vendo_meta WHERE key = 'boot_id'")).rows[0]?.value;
      expect(after).toBe(before);
    });

    it("migrates a version 1 database to the additive door tables", async () => {
      await made.sql("DROP TABLE vendo_mcp_clients, vendo_mcp_grants");
      await made.sql("UPDATE vendo_meta SET value = '1'::jsonb WHERE key = 'schema_version'");

      await made.store.ensureSchema();

      expect((await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value).toBe(2);
      const rows = await made.sql(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('vendo_mcp_clients', 'vendo_mcp_grants')
         ORDER BY table_name`,
      );
      expect(rows).toEqual([
        { table_name: "vendo_mcp_clients" },
        { table_name: "vendo_mcp_grants" },
      ]);
    });

    it("creates all 13 contract tables with every contracted key column", async () => {
      const rows = await made.sql(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'vendo_%'",
      );
      const actual = new Map<string, Set<string>>();
      for (const row of rows) {
        const table = String(row.table_name);
        const columns = actual.get(table) ?? new Set<string>();
        columns.add(String(row.column_name));
        actual.set(table, columns);
      }
      expect(actual.size).toBe(13);
      for (const [table, columns] of Object.entries(CONTRACT_COLUMNS)) {
        expect(actual.has(table), table).toBe(true);
        for (const column of columns) expect(actual.get(table)?.has(column), `${table}.${column}`).toBe(true);
      }
    });

    it("stores every contracted JSON column as jsonb", async () => {
      // 02-store §2: "All JSON is jsonb." The table map is public, so the storage type is contract.
      const jsonbColumns: Array<[string, string]> = [
        ["vendo_meta", "value"],
        ["vendo_apps", "doc"],
        ["vendo_records", "data"],
        ["vendo_records", "refs"],
        ["vendo_state", "data"],
        ["vendo_threads", "messages"],
        ["vendo_grants", "scope"],
        ["vendo_approvals", "request"],
        ["vendo_audit", "event"],
        ["vendo_runs", "trigger"],
        ["vendo_runs", "record"],
        ["vendo_mcp_clients", "data"],
        ["vendo_mcp_grants", "data"],
      ];
      const rows = await made.sql(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'vendo_%'",
      );
      const typeOf = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, String(row.data_type)]));
      for (const [table, column] of jsonbColumns) {
        expect(typeOf.get(`${table}.${column}`), `${table}.${column}`).toBe("jsonb");
      }
      // vendo_secrets.ciphertext is deliberately text, not jsonb (§4 at-rest encryption).
      expect(typeOf.get("vendo_secrets.ciphertext")).toBe("text");
    });

    // Parameterized over vendo_records plus the wave-6 door tables (supersedes a
    // single-table check): every refs column the host joins on gets a GIN index.
    for (const table of ["vendo_records", "vendo_mcp_clients", "vendo_mcp_grants"] as const) {
      it(`creates a GIN index on ${table}.refs`, async () => {
        const rows = await made.sql(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
          [table],
        );
        expect(rows.some((row) => /USING gin \(refs/.test(String(row.indexdef)))).toBe(true);
      });
    }

    it("rejects a future schema version as a conflict", async () => {
      await made.sql("UPDATE vendo_meta SET value = '999'::jsonb WHERE key = 'schema_version'");
      await made.store.close();
      const reopened = createStore({ url: made.url, dataDir: made.dataDir });
      try {
        await expect(reopened.ensureSchema()).rejects.toMatchObject<VendoError>({ code: "conflict" });
      } finally {
        await reopened.close();
      }
    });
  });
}

describe("PGlite open failures", () => {
  it("retries after a failed open instead of retaining the rejected promise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vendo-store-open-failure-"));
    const dataDir = join(dir, "not-a-directory");
    await writeFile(dataDir, "file");
    const store = createStore({ dataDir });
    try {
      const first = await store.ensureSchema().catch((error: unknown) => error);
      expect(first).toBeInstanceOf(Error);
      expect((first as Error).message).toContain(`[vendo] PGlite data directory "${dataDir}" is not writable`);

      const second = await store.ensureSchema().catch((error: unknown) => error);
      expect(second).toBeInstanceOf(Error);
      expect((second as Error).message).toBe((first as Error).message);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { VendoError } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { createStore } from "./index.js";

const CONTRACT_COLUMNS: Record<string, string[]> = {
  vendo_meta: ["key", "value"],
  vendo_apps: ["id", "subject", "enabled", "doc", "created_at", "updated_at"],
  vendo_records: ["collection", "id", "data", "refs", "created_at", "updated_at"],
  vendo_blobs: ["namespace", "key", "bytes", "content_type", "created_at"],
  vendo_state: ["app_id", "subject", "data", "updated_at"],
  vendo_threads: ["id", "subject", "messages", "created_at", "updated_at"],
  vendo_grants: ["id", "subject", "tool", "descriptor_hash", "scope", "duration", "app_id", "source", "granted_at", "revoked_at", "expires_at"],
  vendo_approvals: ["id", "subject", "request", "status", "decided_at", "created_at"],
  vendo_audit: ["id", "at", "kind", "subject", "venue", "presence", "app_id", "tool", "event"],
  vendo_runs: ["id", "app_id", "trigger", "status", "record", "started_at", "finished_at"],
  vendo_secrets: ["name", "ciphertext", "created_at"],
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
        expect.objectContaining({ key: "schema_version", value: 1 }),
        expect.objectContaining({ key: "boot_id" }),
      ]));
      expect(rows.find((row) => row.key === "boot_id")?.value).toEqual(expect.any(String));
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

    it("creates all 11 contract tables with every contracted key column", async () => {
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
      expect(actual.size).toBe(11);
      for (const [table, columns] of Object.entries(CONTRACT_COLUMNS)) {
        expect(actual.has(table), table).toBe(true);
        for (const column of columns) expect(actual.get(table)?.has(column), `${table}.${column}`).toBe(true);
      }
    });

    it("creates a GIN index on vendo_records.refs", async () => {
      const rows = await made.sql(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'vendo_records'",
      );
      expect(rows.some((row) => /USING gin \(refs/.test(String(row.indexdef)))).toBe(true);
    });

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

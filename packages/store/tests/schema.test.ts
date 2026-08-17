import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { createStore } from "../src/index.js";

const CONTRACT_COLUMNS: Record<string, string[]> = {
  vendo_meta: ["key", "value"],
  vendo_apps: ["id", "subject", "enabled", "doc", "created_at", "updated_at"],
  vendo_records: ["collection", "id", "data", "refs", "created_at", "updated_at", "revision"],
  vendo_blobs: ["namespace", "key", "bytes", "content_type", "created_at"],
  vendo_state: ["app_id", "subject", "data", "updated_at"],
  vendo_threads: ["id", "subject", "created_at", "updated_at"],
  vendo_thread_messages: ["thread_id", "id", "seq", "message", "revision", "created_at", "updated_at"],
  vendo_effects: ["key", "outcome", "at"],
  vendo_grants: ["id", "subject", "tool", "descriptor_hash", "scope", "duration", "app_id", "automation_id", "source", "granted_at", "revoked_at", "expires_at"],
  vendo_approvals: ["id", "subject", "request", "status", "decided_at", "created_at"],
  vendo_audit: ["id", "at", "kind", "subject", "venue", "presence", "app_id", "tool", "event"],
  vendo_automations: ["id", "subject", "armed", "data", "when_kind", "created_at", "updated_at", "revision"],
  vendo_runs: ["id", "automation_id", "trigger", "status", "record", "started_at", "finished_at"],
  vendo_secrets: ["name", "ciphertext", "created_at"],
  vendo_mcp_clients: ["id", "data", "refs", "created_at", "updated_at"],
  vendo_mcp_grants: ["id", "data", "refs", "created_at", "updated_at"],
  vendo_knowledge_docs: ["id", "data", "refs", "created_at", "updated_at"],
  vendo_knowledge_chunks: ["id", "data", "refs", "created_at", "updated_at"],
  vendo_workspace_files: ["path", "owner", "content", "blob_ref", "bytes", "revision", "created_at", "updated_at"],
  vendo_workspace_history: ["id", "path", "owner", "revision", "content", "blob_ref", "intent", "at"],
  vendo_app_grants: ["id", "app_id", "org_id", "principal", "level", "created_by", "created_at"],
  vendo_idempotency_ledger: ["tenant", "op", "key", "request_hash", "status", "result", "created_at"],
  vendo_quarantine: ["collection", "id", "data", "subject", "app_id", "quarantined_at"],
  vendo_usage: ["id", "subject", "action", "at", "pool_keys"],
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
        expect.objectContaining({ key: "schema_version", value: 11 }),
        expect.objectContaining({ key: "boot_id" }),
      ]));
      expect(rows.find((row) => row.key === "boot_id")?.value).toEqual(expect.any(String));
    });

    it("lands a fresh database directly on schema version 11", async () => {
      // A brand-new DB never runs the v2 backfill's DELETE against real data; it
      // just records the current version. (beforeAll already ran ensureSchema.)
      const version = (await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value;
      expect(version).toBe(11);
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

      expect((await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value).toBe(11);
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

    it("migrates a version 2 database to the current version without re-running the v2 backfill", async () => {
      // A v2 database may hold a LIVE vendo_records row that happens to match the
      // v2 backfill predicate; the 2→3 upgrade must not relocate/DELETE it again.
      await made.sql("UPDATE vendo_meta SET value = '2'::jsonb WHERE key = 'schema_version'");
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, created_at, updated_at)
         VALUES ('vendo_state', 'app_live:subject_live', '{"live":true}'::jsonb, now(), now())
         ON CONFLICT DO NOTHING`,
      );

      await made.store.ensureSchema();

      expect((await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value).toBe(11);
      const survivor = await made.sql(
        "SELECT id FROM vendo_records WHERE collection = 'vendo_state' AND id = 'app_live:subject_live'",
      );
      expect(survivor).toEqual([{ id: "app_live:subject_live" }]);
      await made.sql("DELETE FROM vendo_records WHERE collection = 'vendo_state' AND id = 'app_live:subject_live'");
    });

    it("creates all 24 contract tables with every contracted key column", async () => {
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
      // 20 at wave-1 integration: 16 shipped + lane D's vendo_thread_messages
      // and vendo_effects + lane B's vendo_workspace_files and
      // vendo_workspace_history. Each lane asserted 18 counting only its own
      // pair; the merged v6 carries all four. v7 (wave 3, build contract §9.2)
      // adds vendo_app_grants — the only multi-party rows Vendo stores. Guest
      // sessions were then deleted, taking vendo_sessions back out. v8 adds
      // vendo_idempotency_ledger — the `Idempotency-Key` replay ledger, which
      // has to live in the same database as the mutations it gates (01 §12).
      // v9 adds vendo_quarantine — where a retention sweep parks the rows it
      // lifts until a purge destroys them (01 §12 StoreOps.retention). v10 adds
      // vendo_usage — the meter a host's limits policy decides on, one row per
      // metered action (01 §12 StoreOps.usage). v11 adds vendo_automations —
      // the automation record itself, first-class and principal-owned, which is
      // also what re-keys vendo_runs off its app.
      expect(actual.size).toBe(24);
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
        ["vendo_thread_messages", "message"],
        ["vendo_effects", "outcome"],
        ["vendo_grants", "scope"],
        ["vendo_approvals", "request"],
        ["vendo_audit", "event"],
        ["vendo_automations", "data"],
        ["vendo_runs", "trigger"],
        ["vendo_runs", "record"],
        ["vendo_mcp_clients", "data"],
        ["vendo_mcp_grants", "data"],
        ["vendo_knowledge_docs", "data"],
        ["vendo_knowledge_chunks", "data"],
        ["vendo_quarantine", "data"],
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
    for (const table of ["vendo_records", "vendo_mcp_clients", "vendo_mcp_grants", "vendo_knowledge_docs", "vendo_knowledge_chunks"] as const) {
      it(`creates a GIN index on ${table}.refs`, async () => {
        const rows = await made.sql(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
          [table],
        );
        expect(rows.some((row) => /USING gin \(refs/.test(String(row.indexdef)))).toBe(true);
      });
    }

    it("indexes vendo_app_grants by principal, not only by app", async () => {
      // The apps runtime runs a PRINCIPAL-ONLY query per encoding on every
      // apps.list (runtime.ts `grantedRecords`): one per org, one per team, one
      // for the user. Without this index each of those is a seq scan of every
      // grant row in the deployment, on the hot list path.
      const rows = await made.sql(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'vendo_app_grants'",
      );
      expect(rows.some((row) => /\(principal\)/.test(String(row.indexdef)))).toBe(true);
    });

    it("drops a leftover vendo_sessions table", async () => {
      // Guest sessions are gone and the CREATE was removed without a version bump,
      // so a database that booted on v4 still carries the orphan; ADDITIVE_DDL's
      // drop is the only thing that removes it.
      await made.sql("CREATE TABLE vendo_sessions (subject text PRIMARY KEY, touched_at timestamptz NOT NULL)");

      await made.store.ensureSchema();

      const rows = await made.sql(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'vendo_sessions'`,
      );
      expect(rows).toEqual([]);
    });

    it("is a no-op on a database that never had vendo_sessions", async () => {
      // The previous test left it dropped; running again must not error.
      await made.store.ensureSchema();

      const rows = await made.sql(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'vendo_sessions'`,
      );
      expect(rows).toEqual([]);
    });

    it("drops every leftover trigger-kind projection off vendo_apps", async () => {
      // v11: an app document has no triggers, so the columns that projected
      // their kinds are orphans on any database that booted before the v11 DDL.
      // The drop matches them by pattern, which is what lets it clean off both
      // the pre-list column recreated here and the per-kind generated ones.
      await made.sql("ALTER TABLE vendo_apps ADD COLUMN trigger_kind text");

      await made.store.ensureSchema();

      const rows = await made.sql(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'vendo_apps' AND column_name LIKE 'trigger%'`,
      );
      expect(rows).toEqual([]);
    });

    it("rejects a future schema version as a conflict", async () => {
      await made.sql("UPDATE vendo_meta SET value = '999'::jsonb WHERE key = 'schema_version'");
      await made.store.close();
      const reopened = createStore({ url: made.url, dataDir: made.dataDir });
      try {
        await expect(reopened.ensureSchema()).rejects.toMatchObject({ code: "conflict" });
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

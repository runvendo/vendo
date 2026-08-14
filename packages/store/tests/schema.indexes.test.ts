import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore, createStoreForDb, maybeDbFor, threadStore, type Db, type VendoStore } from "../src/index.js";
import { persistentPrincipal } from "../src/fixtures.test-util.js";
import { cursorMs } from "../src/helpers/utils.js";

// The hot lists order by `date_trunc('milliseconds', <col>, 'UTC') DESC, id DESC`
// (helpers/utils.ts cursorMs). The 2-arg form of that call reads the TimeZone GUC,
// so Postgres refuses it in an index expression and every routed list degrades to a
// seq scan + sort; the 3-arg 'UTC' form is IMMUTABLE, which is what makes the
// ADDITIVE_DDL indexes below creatable at all. This suite proves both halves on a
// real engine: the DDL is accepted, and the planner actually picks the index for
// the exact SQL the read path emits.
//
// HONESTY NOTES:
// - 1000 rows is the smallest count at which the planner flips for ALL THREE shapes
//   on PGlite (PostgreSQL 18.3). Measured: the unfiltered and cursor pages flip at
//   ~100 rows, the subject-filtered composite is still seq-scanning at 500 and only
//   settles onto the index from 600 up. The blueprint's 200k-row measurement is real
//   Postgres; seeding that through the real put path here is not practical.
// - `ANALYZE` is required and is not a thumb on the scale: without stats a fresh
//   table reads as empty to the planner. Production gets the same stats from
//   autovacuum. Nothing here disables seq scans.
const ROWS = 1000;
const SUBJECTS = 5;

/** The scan node(s) the plan uses for the listed table, one line each. */
function scanNodes(plan: string, table: string): string[] {
  return plan.split("\n").filter((line) => new RegExp(`Scan.* on ${table}\\b`).test(line)).map((line) => line.trim());
}

describe("hot-list indexes ride the routed read path", () => {
  let dataDir: string;
  let base: VendoStore;
  let db: Db;
  let store: VendoStore;
  let lastQuery: { text: string; params: unknown[] } | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vendo-store-indexes-"));
    base = createStore({ dataDir });
    const engine = maybeDbFor(base);
    if (engine === undefined) throw new Error("expected a PGlite-backed store");
    db = engine;
    // The seam this slice exports: a Db handed straight to createStoreForDb. Here it
    // is the real engine wrapped to record the exact SQL the read path emits, so the
    // EXPLAINs below run the query under test rather than a hand-written lookalike.
    store = createStoreForDb({
      ...db,
      async query(text: string, params: unknown[] = []) {
        lastQuery = { text, params };
        return await db.query(text, params);
      },
    });
    await store.ensureSchema();
    const threads = threadStore(store);
    for (let i = 0; i < ROWS; i += 1) {
      await threads.put(
        { ...persistentPrincipal, subject: `sub_${i % SUBJECTS}` },
        { id: `thr_${String(i).padStart(5, "0")}`, messages: [] },
      );
    }
    await db.query("ANALYZE vendo_threads");
  });

  afterAll(async () => {
    await base.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** EXPLAIN the SQL the read path just emitted, verbatim. */
  async function planOfLastQuery(): Promise<string> {
    if (lastQuery === undefined) throw new Error("no query recorded");
    const result = await db.query(`EXPLAIN ${lastQuery.text}`, lastQuery.params);
    return result.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  it("accepts the expression cursorMs emits in an index — it is IMMUTABLE", async () => {
    // The coupling the whole slice rests on: the indexes below are only reachable
    // while the read path's own sort expression is indexable. Postgres refuses the
    // 2-arg form here with "functions in index expression must be marked IMMUTABLE".
    // On a scratch table, so the probe index can never enter a plan under test.
    await db.query("CREATE TABLE cursorms_probe (id text PRIMARY KEY, created_at timestamptz NOT NULL)");
    await expect(db.query(
      `CREATE INDEX cursorms_probe_idx ON cursorms_probe (${cursorMs("created_at")} DESC, id DESC)`,
    )).resolves.toBeDefined();
  });

  it("creates every hot-list index", async () => {
    const result = await db.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
      [[
        "vendo_threads_created_idx", "vendo_apps_created_idx", "vendo_runs_started_idx",
        "vendo_approvals_created_idx", "vendo_grants_granted_idx", "vendo_state_created_idx",
        "vendo_app_grants_created_idx", "vendo_effects_at_idx", "vendo_threads_subject_created_idx",
        "vendo_runs_status_started_idx", "vendo_approvals_status_created_idx",
        "vendo_state_subject_created_idx", "vendo_audit_app_at_idx", "vendo_grants_app_granted_idx",
      ]],
    );
    expect(result.rows).toHaveLength(14);
  });

  it("serves the unfiltered first page from vendo_threads_created_idx", async () => {
    const page = await store.records("vendo_threads").list({ limit: 100 });
    expect(page.records).toHaveLength(100);
    const plan = await planOfLastQuery();
    expect(scanNodes(plan, "vendo_threads").join("\n")).toContain("Index Scan using vendo_threads_created_idx");
    expect(plan).not.toContain("Seq Scan on vendo_threads");
  });

  it("serves a cursor page from vendo_threads_created_idx", async () => {
    const first = await store.records("vendo_threads").list({ limit: 100 });
    expect(first.cursor).toBeDefined();
    const next = await store.records("vendo_threads").list({ limit: 100, cursor: first.cursor as string });
    expect(next.records).toHaveLength(100);
    expect(next.records[0]?.id).not.toEqual(first.records[0]?.id);
    const plan = await planOfLastQuery();
    expect(scanNodes(plan, "vendo_threads").join("\n")).toContain("Index Scan using vendo_threads_created_idx");
    expect(plan).not.toContain("Seq Scan on vendo_threads");
  });

  it("serves a subject-filtered page from the composite vendo_threads_subject_created_idx", async () => {
    const page = await store.records("vendo_threads").list({ limit: 100, refs: { subject: "sub_1" } });
    expect(page.records).toHaveLength(100);
    const plan = await planOfLastQuery();
    expect(scanNodes(plan, "vendo_threads").join("\n")).toContain("Index Scan using vendo_threads_subject_created_idx");
    expect(plan).not.toContain("Seq Scan on vendo_threads");
  });
});

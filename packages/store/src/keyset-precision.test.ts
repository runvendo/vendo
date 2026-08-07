import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, auditFixture, persistentPrincipal } from "./fixtures.test-util.js";
import { appStore, auditStore, runStore } from "./index.js";

// Keyset cursors round-trip through JS Dates (millisecond precision), but the
// timestamptz cursor columns store microseconds: the §2 table map is public
// (direct host SQL), vendo_state.created_at has a DEFAULT now() for exactly
// that path, and caller-supplied ISO timestamps (audit `at`, run `startedAt`)
// are z.string().datetime()-validated, which accepts sub-millisecond digits.
// Every keyset predicate must therefore compare at the cursor's millisecond
// granularity — a full-precision comparison against a truncated cursor makes
// rows sharing a truncated timestamp silently fall out of pagination.
const MICRO_AT = "2026-03-04T05:06:07.123456Z";

/** Follow a cursored list to exhaustion, guarding against a runaway loop. */
async function collect(
  page: (cursor: string | undefined) => Promise<{ ids: string[]; cursor?: string }>,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let hops = 0; ; hops += 1) {
    if (hops > 20) throw new Error("pagination did not terminate");
    const result = await page(cursor);
    seen.push(...result.ids);
    if (result.cursor === undefined) return seen;
    cursor = result.cursor;
  }
}

for (const backend of backends()) {
  describe(`keyset pagination at microsecond timestamps (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("lists every generic record when a page boundary lands on a shared microsecond created_at", async () => {
      await appStore(made.store).put(persistentPrincipal, appFixture("app_micro", "Micro"));
      for (let i = 1; i <= 5; i += 1) {
        await made.sql(
          "INSERT INTO vendo_records (collection, id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
          ["app:app_micro:notes", `note_${i}`, JSON.stringify({ n: i }), MICRO_AT],
        );
      }
      const records = made.store.records("app:app_micro:notes");
      const seen = await collect(async (cursor) => {
        const page = await records.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        return {
          ids: page.records.map((record) => record.id),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      });
      expect(seen.sort()).toEqual(["note_1", "note_2", "note_3", "note_4", "note_5"]);
    });

    it("lists every vendo_state row when created_at carries microseconds (the DEFAULT now() path)", async () => {
      for (let i = 1; i <= 5; i += 1) {
        await made.sql(
          "INSERT INTO vendo_state (app_id, subject, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
          ["app_micro_state", `user_micro_${i}`, "{}", MICRO_AT],
        );
      }
      const state = made.store.records("vendo_state");
      const seen = await collect(async (cursor) => {
        const page = await state.list({
          limit: 2,
          refs: { app_id: "app_micro_state" },
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          ids: page.records.map((record) => record.id),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      });
      expect(seen.sort()).toEqual(
        [1, 2, 3, 4, 5].map((i) => `app_micro_state:user_micro_${i}`),
      );
    });

    it("lists every run when startedAt is a caller-supplied sub-millisecond timestamp", async () => {
      const runs = runStore(made.store);
      for (let i = 1; i <= 5; i += 1) {
        await runs.put({
          id: `run_micro_${i}`,
          appId: "app_micro_runs",
          trigger: { kind: "schedule" },
          status: "running",
          record: { transient: true },
          startedAt: MICRO_AT,
        });
      }
      const seen = await collect(async (cursor) => {
        const page = await runs.list({
          appId: "app_micro_runs",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          ids: page.runs.map((run) => run.id),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      });
      expect(seen.sort()).toEqual(
        [1, 2, 3, 4, 5].map((i) => `run_micro_${i}`),
      );
    });

    it("pages audit query() past a shared microsecond `at` without dropping events", async () => {
      const audit = auditStore(made.store);
      for (let i = 1; i <= 5; i += 1) {
        await audit.append(auditFixture(`aud_micro_${i}`, { at: MICRO_AT, appId: "app_micro_audit" }));
      }
      const seen = await collect(async (cursor) => {
        const page = await audit.query({
          appId: "app_micro_audit",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          ids: page.events.map((event) => event.id),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      });
      expect(seen.sort()).toEqual(
        [1, 2, 3, 4, 5].map((i) => `aud_micro_${i}`),
      );
    });
  });
}

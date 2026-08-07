import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { appFixture, at } from "../fixtures.test-util.js";
import { appStore } from "../index.js";
import { runStore } from "./runs.js";
import type { RunRow } from "./types.js";

function runFixture(overrides: Partial<RunRow> & Pick<RunRow, "id" | "appId" | "startedAt">): RunRow {
  return {
    trigger: { kind: "schedule" },
    status: "running",
    record: { step: 1 },
    ...overrides,
  };
}

for (const backend of backends()) {
  describe(`runStore (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("returns null for a run that was never written", async () => {
      const runs = runStore(made.store);
      expect(await runs.get("run_missing_entirely")).toBeNull();
    });

    it("puts a run and reads it back verbatim, then upserts in place on a second put", async () => {
      const runs = runStore(made.store);
      await runs.put(runFixture({
        id: "run_basic",
        appId: "app_runs_basic",
        startedAt: at(1),
        record: { step: 1 },
        status: "running",
      }));
      expect(await runs.get("run_basic")).toEqual({
        id: "run_basic",
        appId: "app_runs_basic",
        trigger: { kind: "schedule" },
        status: "running",
        record: { step: 1 },
        startedAt: at(1),
      });

      await runs.put(runFixture({
        id: "run_basic",
        appId: "app_runs_basic",
        startedAt: at(1),
        status: "ok",
        record: { step: 2 },
        finishedAt: at(2),
      }));
      const updated = await runs.get("run_basic");
      expect(updated).toEqual({
        id: "run_basic",
        appId: "app_runs_basic",
        trigger: { kind: "schedule" },
        status: "ok",
        record: { step: 2 },
        startedAt: at(1),
        finishedAt: at(2),
      });
    });

    it("preserves the trigger event field and host-event/external trigger kinds", async () => {
      const runs = runStore(made.store);
      await runs.put({
        id: "run_trigger_event",
        appId: "app_runs_trigger",
        trigger: { kind: "host-event", event: "invoice.created" },
        status: "ok",
        record: {},
        startedAt: at(3),
      });
      expect(await runs.get("run_trigger_event")).toMatchObject({
        trigger: { kind: "host-event", event: "invoice.created" },
      });

      await runs.put({
        id: "run_trigger_external",
        appId: "app_runs_trigger",
        trigger: { kind: "external" },
        status: "ok",
        record: {},
        startedAt: at(4),
      });
      expect(await runs.get("run_trigger_external")).toMatchObject({ trigger: { kind: "external" } });
    });

    it("filters list() by appId and by status independently and together", async () => {
      const runs = runStore(made.store);
      await runs.put(runFixture({ id: "run_filter_a", appId: "app_filter_1", startedAt: at(10), status: "ok" }));
      await runs.put(runFixture({ id: "run_filter_b", appId: "app_filter_1", startedAt: at(11), status: "error" }));
      await runs.put(runFixture({ id: "run_filter_c", appId: "app_filter_2", startedAt: at(12), status: "ok" }));

      expect((await runs.list({ appId: "app_filter_1" })).runs.map((run) => run.id).sort())
        .toEqual(["run_filter_a", "run_filter_b"]);
      expect((await runs.list({ status: "ok" })).runs.map((run) => run.id))
        .toEqual(expect.arrayContaining(["run_filter_a", "run_filter_c"]));
      expect((await runs.list({ status: "ok" })).runs.map((run) => run.id)).not.toContain("run_filter_b");
      expect((await runs.list({ appId: "app_filter_1", status: "error" })).runs.map((run) => run.id))
        .toEqual(["run_filter_b"]);
      expect((await runs.list({ appId: "app_filter_2", status: "error" })).runs).toEqual([]);
    });

    it("orders list() newest-first by startedAt, breaking ties by id descending", async () => {
      const runs = runStore(made.store);
      const shared = at(20);
      await runs.put(runFixture({ id: "run_order_a", appId: "app_order", startedAt: shared }));
      await runs.put(runFixture({ id: "run_order_b", appId: "app_order", startedAt: shared }));
      await runs.put(runFixture({ id: "run_order_c", appId: "app_order", startedAt: at(21) }));
      const listed = await runs.list({ appId: "app_order" });
      expect(listed.runs.map((run) => run.id)).toEqual(["run_order_c", "run_order_b", "run_order_a"]);
    });

    it("paginates list() with a cursor until exhausted, in strict newest-first order", async () => {
      const runs = runStore(made.store);
      for (let i = 0; i < 5; i += 1) {
        await runs.put(runFixture({ id: `run_page_${i}`, appId: "app_paginate", startedAt: at(30 + i) }));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await runs.list({ appId: "app_paginate", limit: 2, cursor });
        expect(page.runs.length).toBeLessThanOrEqual(2);
        seen.push(...page.runs.map((run) => run.id));
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual(["run_page_4", "run_page_3", "run_page_2", "run_page_1", "run_page_0"]);
    });

    it("writes ephemeral-app runs to vendo_runs like any other (kill-list B3)", async () => {
      const ephemeral: Principal = { kind: "user", subject: "sess_runs", ephemeral: true };
      const doc = appFixture("app_runs_ephemeral", "Ephemeral runs");
      await appStore(made.store).put(ephemeral, doc);
      const runs = runStore(made.store);
      await runs.put(runFixture({ id: "run_ephemeral", appId: doc.id, startedAt: at(40), record: { transient: true } }));

      expect(await runs.get("run_ephemeral")).toMatchObject({ appId: doc.id, record: { transient: true } });
      expect((await runs.list({ appId: doc.id })).runs.map((run) => run.id)).toEqual(["run_ephemeral"]);
      const rows = await made.sql("SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1", [doc.id]);
      expect(Number(rows[0]?.["count"])).toBe(1);
    });

    it("rejects malformed run data before storing anything, for each invalid field", async () => {
      const runs = runStore(made.store);

      await expect(runs.put({
        id: "run_bad_trigger",
        appId: "app_bad",
        trigger: { kind: "not-a-real-kind" } as never,
        status: "running",
        record: {},
        startedAt: at(60),
      })).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await runs.get("run_bad_trigger")).toBeNull();

      await expect(runs.put({
        id: "run_bad_status",
        appId: "app_bad",
        trigger: { kind: "schedule" },
        status: "not-a-real-status" as never,
        record: {},
        startedAt: at(61),
      })).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await runs.get("run_bad_status")).toBeNull();

      await expect(runs.put({
        id: "run_bad_app_id",
        appId: "not-app-prefixed" as never,
        trigger: { kind: "schedule" },
        status: "running",
        record: {},
        startedAt: at(62),
      })).rejects.toMatchObject<VendoError>({ code: "validation" });

      await expect(runs.put({
        id: "run_bad_started_at",
        appId: "app_bad",
        trigger: { kind: "schedule" },
        status: "running",
        record: {},
        startedAt: "not-a-date",
      })).rejects.toMatchObject<VendoError>({ code: "validation" });
      expect(await runs.get("run_bad_started_at")).toBeNull();
    });
  });
}

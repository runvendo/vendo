import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { at, auditFixture } from "../src/fixtures.test-util.js";
import { encodeCursor } from "../src/helpers/utils.js";
import { createStore, createStoreOps } from "../src/index.js";
import { STORE_WIRE_PATHS, type StoreOps } from "@vendoai/core";

/** One run at an exact instant — the watermark walk's only subject, because
 *  `vendo_runs.started_at` is the one indexed field the registry declares. */
const putRun = async (ops: StoreOps, id: string, startedAt: string): Promise<void> => {
  await ops.engine.put("vendo_runs", {
    id,
    data: { automationId: "atm_test", trigger: { kind: "schedule" }, status: "ok", record: {}, startedAt },
  });
};

// The local backend's OWN laws, beyond the shared conformance suite: the F4
// cascade proven at the rows, and the per-collection policies the routed
// doors enforce (deliberately excluded from core's suite — the collection
// registry lives in this package).
for (const backend of backends()) {
  describe(`${backend.name} StoreOps local backend`, () => {
    const makeOps = async (): Promise<{ made: MadeBackend; ops: StoreOps }> => {
      const made = await backend.make();
      await made.store.ensureSchema();
      return { made, ops: createStoreOps(made.store) };
    };

    it("F4 — deleteThread removes the thread, its message rows, and its harness state together", async () => {
      const { made, ops } = await makeOps();
      try {
        await ops.transcripts.putThread({
          id: "thr_f4",
          subject: "user_f4",
          messages: [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }],
        });
        await ops.transcripts.putMessage("thr_f4", { id: "m3", role: "user" });
        await ops.harness.set("harness_state:thr_f4", "user_f4", { session: "native_1" });
        // Write-through: the rows the verb must sweep really exist first.
        expect((await made.sql("SELECT 1 FROM vendo_thread_messages WHERE thread_id = $1", ["thr_f4"])).length).toBe(3);
        expect((await made.sql("SELECT 1 FROM vendo_state WHERE app_id = $1", ["harness_state:thr_f4"])).length).toBe(1);

        await ops.transcripts.deleteThread("thr_f4");

        // Read-back at the SQL level: nothing survives — the orphaned-message
        // gap threadStore.delete left open (F4) is closed by the verb.
        expect((await made.sql("SELECT 1 FROM vendo_threads WHERE id = $1", ["thr_f4"])).length).toBe(0);
        expect((await made.sql("SELECT 1 FROM vendo_thread_messages WHERE thread_id = $1", ["thr_f4"])).length).toBe(0);
        expect((await made.sql("SELECT 1 FROM vendo_state WHERE app_id = $1", ["harness_state:thr_f4"])).length).toBe(0);
      } finally {
        await made.cleanup();
      }
    });

    it("vendo_audit is append-only through the ops door", async () => {
      const { made, ops } = await makeOps();
      try {
        const event = auditFixture("aud_ops_1");
        await ops.engine.put("vendo_audit", { id: event.id, data: event });
        await expect(ops.engine.put("vendo_audit", { id: event.id, data: event }))
          .rejects.toMatchObject({ code: "conflict" });
        await expect(ops.engine.delete("vendo_audit", event.id))
          .rejects.toMatchObject({ code: "blocked" });
      } finally {
        await made.cleanup();
      }
    });

    it("vendo_effects receipts are insert-once and immutable", async () => {
      const { made, ops } = await makeOps();
      try {
        const receipt = { subject: "user_fx", outcome: { sent: true } };
        const first = await ops.engine.insertIfAbsent("vendo_effects", { id: "fx_1", data: receipt });
        expect(first?.id).toBe("fx_1");
        expect(await ops.engine.insertIfAbsent("vendo_effects", { id: "fx_1", data: { subject: "user_fx", outcome: { sent: false } } })).toBeNull();
        // Even the plain put hands back the RECORDED receipt, never a rewrite.
        const replayed = await ops.engine.put("vendo_effects", { id: "fx_1", data: { subject: "user_fx", outcome: { sent: false } } });
        expect(replayed.data).toMatchObject({ outcome: { sent: true } });
        await expect(ops.engine.compareAndSwap("vendo_effects", { id: "fx_1", data: receipt }, "1"))
          .rejects.toMatchObject({ code: "blocked" });
      } finally {
        await made.cleanup();
      }
    });

    it("status() reports the 48 ops this wire serves", async () => {
      const { made, ops } = await makeOps();
      try {
        const status = await ops.status();
        // All 48, against the manifest rather than a literal: `ops` is a LEVEL
        // over STORE_WIRE_PATHS' declared order, and this engine now serves
        // every op on it — including audit.tally, declared past `status`, which
        // no level could reach while retention was missing from the middle.
        expect(status.ops).toBe(Object.keys(STORE_WIRE_PATHS).length);
        // The families are what the level is claiming, so assert them together
        // or the number can drift ahead of the objects it describes.
        expect(ops.retention).toBeDefined();
        expect(ops.usage).toBeDefined();
        // Nothing left to announce: the handshake carries the format and the
        // count, and the retired generic family is not advertised as anything.
        expect(Object.keys(status).sort()).toEqual(["format", "ops"]);
      } finally {
        await made.cleanup();
      }
    });

    it("subject-guarded upserts refuse a cross-subject flip", async () => {
      const { made, ops } = await makeOps();
      try {
        await ops.engine.put("vendo_threads", {
          id: "thr_guard",
          data: { subject: "user_a", messages: [] },
        });
        await expect(ops.engine.put("vendo_threads", {
          id: "thr_guard",
          data: { subject: "user_b", messages: [] },
        })).rejects.toMatchObject({ code: "conflict" });
      } finally {
        await made.cleanup();
      }
    });

    it("two concurrent commits racing one idempotency key: exactly one lands, the other conflicts", async () => {
      const { made, ops } = await makeOps();
      try {
        // Same key, DIFFERENT bodies, fired together. The ledger claim (the
        // unique (collection, id) insert BEFORE any row mutation) is the
        // serialization point: the loser must conflict, never apply a second
        // mutation while only one body stays recorded for the key.
        const results = await Promise.allSettled([
          ops.workspace.commit([{ path: "race.json", data: { v: "first" } }], { idempotencyKey: "idem_race" }),
          ops.workspace.commit([{ path: "race.json", data: { v: "second" } }], { idempotencyKey: "idem_race" }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason).toMatchObject({ code: "conflict" });
        // Exactly one ledger row for the key, and the file holds the winner's
        // body — the loser's mutation never touched the workspace.
        const rows = await made.sql(
          "SELECT data FROM vendo_records WHERE collection = $1 AND id = $2",
          // The ledger id carries the OWNER as well as the key — two owners
          // pick the same key routinely, and a key-only id answers one owner's
          // commit out of the other's row (see `commitId` in ops.ts).
          ["vendo_workspace_commits", `wsc_key_${JSON.stringify(["user_local", "idem_race"])}`],
        );
        expect(rows.length).toBe(1);
        const winner = results[0]!.status === "fulfilled" ? { v: "first" } : { v: "second" };
        expect((await ops.workspace.read(["race.json"]))["race.json"]).toEqual(winner);
        const recorded = rows[0]!["data"];
        const data = (typeof recorded === "string" ? JSON.parse(recorded) : recorded) as { body?: unknown };
        expect(data.body).toBe(JSON.stringify([{ path: "race.json", data: winner }]));
      } finally {
        await made.cleanup();
      }
    });

    it("harness state is keyed by (appId, subject), so one subject's write leaves the others alone", async () => {
      const { made, ops } = await makeOps();
      try {
        await ops.harness.set("app_shared", "alice", { seen: 1 });
        await ops.harness.set("app_shared", "bob", { seen: 2 });
        await ops.harness.set("app_shared", "alice", { seen: 3 });
        // vendo_state's key is (app_id, subject) — the same key the routed
        // `vendo_state` door splits out of "<appId>:<subject>". A write for one
        // subject must never take another subject's row down with it.
        expect(await ops.harness.get("app_shared", "alice")).toEqual({ seen: 3 });
        expect(await ops.harness.get("app_shared", "bob")).toEqual({ seen: 2 });
        expect((await made.sql("SELECT 1 FROM vendo_state WHERE app_id = $1", ["app_shared"])).length).toBe(2);
        await ops.harness.clear("app_shared", "alice");
        expect(await ops.harness.get("app_shared", "bob")).toEqual({ seen: 2 });
      } finally {
        await made.cleanup();
      }
    });

    it("audit.list filters on the columns AND on the fields inside the event", async () => {
      const { made, ops } = await makeOps();
      try {
        const events = [
          auditFixture("aud_a", { at: at(1), kind: "tool-call", venue: "chat", outcome: "ok" }),
          auditFixture("aud_b", { at: at(2), kind: "policy-decision", venue: "app", outcome: "blocked", decidedBy: "rule" }),
          auditFixture("aud_c", { at: at(3), kind: "policy-decision", venue: "app", outcome: "blocked", decidedBy: "judge" }),
        ];
        for (const event of events) await ops.engine.put("vendo_audit", { id: event.id, data: event });

        // Newest first, and the whole feed when nothing narrows it.
        expect((await ops.audit.list()).events.map((event) => event.id)).toEqual(["aud_c", "aud_b", "aud_a"]);
        // `kind`/`venue` are columns; `outcome`/`decidedBy` are only inside the
        // event jsonb — the filters that made this op worth having.
        expect((await ops.audit.list({ venue: "app" })).events.map((event) => event.id)).toEqual(["aud_c", "aud_b"]);
        expect((await ops.audit.list({ outcome: "blocked", decidedBy: "judge" })).events.map((event) => event.id)).toEqual(["aud_c"]);
        expect((await ops.audit.list({ kind: "tool-call", venue: "app" })).events).toEqual([]);
        // Typed events, not records.
        expect((await ops.audit.list({ kind: "tool-call" })).events[0]?.principal.subject).toBe("user_test");

        // The cursor is the routed door's, so a page taken here can be finished
        // there — the two must never disagree about where a page stopped.
        const first = await ops.audit.list({ limit: 2 });
        expect(first.events.map((event) => event.id)).toEqual(["aud_c", "aud_b"]);
        const rest = await ops.engine.list("vendo_audit", { cursor: first.cursor });
        expect(rest.records.map((record) => record.id)).toEqual(["aud_a"]);
      } finally {
        await made.cleanup();
      }
    });

    it("engine.list walks forward from a watermark WITHOUT losing microseconds", async () => {
      const { made, ops } = await makeOps();
      try {
        // Two runs inside ONE millisecond. A watermark truncated to ms would
        // hand back .123000, and the next walk would re-read run_1 forever —
        // the console incident this precision rule exists for.
        await putRun(ops, "run_1", "2026-03-04T05:06:07.123456Z");
        await putRun(ops, "run_2", "2026-03-04T05:06:07.123789Z");
        await putRun(ops, "run_3", "2026-03-04T05:06:08.000000Z");

        const first = await ops.engine.list("vendo_runs", {
          watermark: { field: "started_at", after: "2026-03-04T05:06:07.000000Z" },
          limit: 1,
        });
        expect(first.records.map((record) => record.id)).toEqual(["run_1"]);
        expect(first.watermark).toBeDefined();

        const second = await ops.engine.list("vendo_runs", {
          watermark: { field: "started_at", after: first.watermark! },
          limit: 1,
        });
        expect(second.records.map((record) => record.id)).toEqual(["run_2"]);

        const third = await ops.engine.list("vendo_runs", {
          watermark: { field: "started_at", after: second.watermark! },
        });
        expect(third.records.map((record) => record.id)).toEqual(["run_3"]);

        // Nothing left: the echo comes back unchanged, so the next pass resumes
        // from the same place rather than from the top.
        const done = await ops.engine.list("vendo_runs", {
          watermark: { field: "started_at", after: third.watermark! },
        });
        expect(done.records).toEqual([]);
        expect(done.watermark).toBe(third.watermark);

        // Same record shape as the ordinary newest-first list.
        expect(first.records[0]).toEqual(
          (await ops.engine.list("vendo_runs", { ids: ["run_1"] })).records[0],
        );
      } finally {
        await made.cleanup();
      }
    });

    it("a watermark is refused on an unindexed field, and never travels with a cursor", async () => {
      const { made, ops } = await makeOps();
      try {
        await expect(ops.engine.list("vendo_runs", { watermark: { field: "finished_at", after: at(1) } }))
          .rejects.toMatchObject({ code: "validation" });
        await expect(ops.engine.list("vendo_audit", { watermark: { field: "at", after: at(1) } }))
          .rejects.toMatchObject({ code: "validation" });
        await expect(ops.engine.list("vendo_runs", {
          watermark: { field: "started_at", after: at(1) },
          cursor: encodeCursor(at(2), "run_x"),
        })).rejects.toMatchObject({ code: "validation" });
      } finally {
        await made.cleanup();
      }
    });

    it("footprint measures row content per collection, counts a thread's messages, and omits the empty", async () => {
      const { made, ops } = await makeOps();
      try {
        // Incompressible on purpose: pg_column_size reports the size Postgres
        // actually stores, and a repeated character would pglz down to nothing.
        await ops.transcripts.putThread({
          id: "thr_fp",
          subject: "user_fp",
          messages: [{ id: "m1", role: "user", text: randomBytes(2048).toString("hex") }],
        });
        await ops.engine.put("vendo_knowledge_docs", { id: "doc_fp", data: { body: randomBytes(1024).toString("hex") } });
        await ops.engine.put("vendo_placements", { id: "plc_fp", data: { slot: "hero" } });

        const footprint = await ops.footprint();
        const bytesOf = (collection: string): number =>
          footprint.find((entry) => entry.collection === collection)?.bytes ?? 0;
        // Sorted by name, and every reported collection is holding something.
        expect(footprint.map((entry) => entry.collection))
          .toEqual([...footprint.map((entry) => entry.collection)].sort());
        expect(footprint.every((entry) => entry.bytes > 0)).toBe(true);
        // The transcript lives in vendo_thread_messages since v6; a thread
        // footprint that counted only the header row would report ~200 bytes.
        expect(bytesOf("vendo_threads")).toBeGreaterThan(4000);
        // Generic-table collections come back too, and the corpus is the one
        // kind that is not `storage`.
        expect(bytesOf("vendo_placements")).toBeGreaterThan(0);
        expect(footprint.find((entry) => entry.collection === "vendo_knowledge_docs")?.kind).toBe("knowledge");
        expect(footprint.find((entry) => entry.collection === "vendo_placements")?.kind).toBe("storage");

        // A collection holding nothing has no entry at all — which is what makes
        // an empty store answer with an empty list.
        await ops.engine.delete("vendo_placements", "plc_fp");
        expect((await ops.footprint()).find((entry) => entry.collection === "vendo_placements"))
          .toBeUndefined();
      } finally {
        await made.cleanup();
      }
    });

    it("secrets delegate to the vault, and an absent name reads as null (not undefined)", async () => {
      const made = await backend.make();
      try {
        // The vault fails closed without a key (secrets.ts), so a store that
        // serves this family has one — the same requirement a BYO mount meets
        // with VENDO_STORE_ENCRYPTION_KEY.
        await made.store.close();
        made.store = createStore({
          url: made.url,
          dataDir: made.dataDir,
          encryption: { key: randomBytes(32).toString("base64") },
        });
        await made.store.ensureSchema();
        const ops = createStoreOps(made.store);

        expect(await ops.secrets.get("MISSING")).toBeNull();
        await ops.secrets.set("API_TOKEN", "shhh");
        expect(await ops.secrets.get("API_TOKEN")).toBe("shhh");
        expect(await ops.secrets.list()).toEqual(["API_TOKEN"]);
        // Encrypted at rest by the vault this op delegates to.
        const row = (await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'API_TOKEN'"))[0];
        expect(String(row?.ciphertext)).not.toContain("shhh");
        await ops.secrets.delete("API_TOKEN");
        expect(await ops.secrets.get("API_TOKEN")).toBeNull();
      } finally {
        await made.cleanup();
      }
    });
  });
}

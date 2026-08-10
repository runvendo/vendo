import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { auditFixture } from "../src/fixtures.test-util.js";
import { createStoreOps } from "../src/index.js";
import type { StoreOps } from "@vendoai/core";

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

    it("status() reports the 35 ops this wire serves", async () => {
      const { made, ops } = await makeOps();
      try {
        const status = await ops.status();
        expect(status.ops).toBe(35);
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
          ["vendo_workspace_commits", "wsc_key_idem_race"],
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
  });
}

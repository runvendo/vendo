import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { auditFixture } from "./fixtures.test-util.js";
import { createStoreOps } from "./index.js";
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
        await ops.records.put("vendo_audit", { id: event.id, data: event });
        await expect(ops.records.put("vendo_audit", { id: event.id, data: event }))
          .rejects.toMatchObject({ code: "conflict" });
        await expect(ops.records.delete("vendo_audit", event.id))
          .rejects.toMatchObject({ code: "blocked" });
      } finally {
        await made.cleanup();
      }
    });

    it("vendo_effects receipts are insert-once and immutable", async () => {
      const { made, ops } = await makeOps();
      try {
        const receipt = { subject: "user_fx", outcome: { sent: true } };
        const first = await ops.records.insertIfAbsent("vendo_effects", { id: "fx_1", data: receipt });
        expect(first?.id).toBe("fx_1");
        expect(await ops.records.insertIfAbsent("vendo_effects", { id: "fx_1", data: { subject: "user_fx", outcome: { sent: false } } })).toBeNull();
        // Even the plain put hands back the RECORDED receipt, never a rewrite.
        const replayed = await ops.records.put("vendo_effects", { id: "fx_1", data: { subject: "user_fx", outcome: { sent: false } } });
        expect(replayed.data).toMatchObject({ outcome: { sent: true } });
        await expect(ops.records.compareAndSwap("vendo_effects", { id: "fx_1", data: receipt }, "1"))
          .rejects.toMatchObject({ code: "blocked" });
      } finally {
        await made.cleanup();
      }
    });

    it("subject-guarded upserts refuse a cross-subject flip", async () => {
      const { made, ops } = await makeOps();
      try {
        await ops.records.put("vendo_threads", {
          id: "thr_guard",
          data: { subject: "user_a", messages: [] },
        });
        await expect(ops.records.put("vendo_threads", {
          id: "thr_guard",
          data: { subject: "user_b", messages: [] },
        })).rejects.toMatchObject({ code: "conflict" });
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

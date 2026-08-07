import { VendoError, type Principal } from "@vendoai/core";
import type { UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { eraseStore, storeFiles, threadMessageStore, threadStore } from "./index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

function message(id: string, text: string, role: "user" | "assistant" = "user"): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

/** The thread row is the ownership record the message doors join against, so a
 *  transcript always has one. Lane A's runtime resolves it the same way. */
async function ownThread(made: MadeBackend, principal: Principal, id: string): Promise<void> {
  await threadStore(made.store).put(principal, { id, messages: [] });
}

for (const backend of backends()) {
  describe(`${backend.name} vendo_thread_messages (build contract §6)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("reassembles by seq, oldest → newest — never by insertion or timestamp order", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      const id = "thr_order";
      await ownThread(made, alice, id);
      // Written out of order on purpose: seq is the only ordering authority.
      await messages.upsert(alice, id, message("m_c", "third"), 2);
      await messages.upsert(alice, id, message("m_a", "first"), 0);
      await messages.upsert(alice, id, message("m_b", "second"), 1);

      const listed = await messages.list(alice, id);
      expect(listed.map((m) => m.id)).toEqual(["m_a", "m_b", "m_c"]);
    });

    it("edits a message in place at its seq, bumping the row revision", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      const id = "thr_edit";
      await ownThread(made, alice, id);
      await messages.upsert(alice, id, message("m_1", "before"), 0);
      await messages.upsert(alice, id, message("m_1", "after"), 0);

      const listed = await messages.list(alice, id);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed[0])).toContain("after");
      const rows = await made.sql(
        "SELECT revision FROM vendo_thread_messages WHERE thread_id = $1 AND id = $2",
        [id, "m_1"],
      );
      expect(Number(rows[0]!["revision"])).toBe(2);
    });

    it("scopes to the principal: one subject never reads another's thread messages", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      const id = "thr_scoped";
      await ownThread(made, alice, id);
      await messages.upsert(alice, id, message("m_secret", "alice only"), 0);

      await expect(messages.list(bob, id)).resolves.toEqual([]);
    });

    it("refuses a cross-subject write to an existing thread", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      const id = "thr_takeover";
      await ownThread(made, alice, id);
      await messages.upsert(alice, id, message("m_1", "mine"), 0);

      await expect(messages.upsert(bob, id, message("m_2", "yours"), 1)).rejects.toBeInstanceOf(VendoError);
      await expect(messages.list(alice, id)).resolves.toHaveLength(1);
    });

    it("erases a populated thread's message rows with its subject", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      // Its own subject, so erasing everything cannot disturb the other cases.
      const carol: Principal = { kind: "user", subject: "user_carol" };
      const id = "thr_erased";
      await ownThread(made, carol, id);
      await messages.upsert(carol, id, message("m_1", "private"), 0);
      await messages.upsert(carol, id, message("m_2", "also private"), 1);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject(carol.subject);

      expect(report.vendo_thread_messages).toBeGreaterThanOrEqual(2);
      const left = await made.sql(
        "SELECT count(*)::int AS n FROM vendo_thread_messages WHERE thread_id = $1",
        [id],
      );
      expect(left[0]!["n"]).toBe(0);
    });

    it("writes one row per message — O(messages), not O(messages²)", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      const id = "thr_rows";
      await ownThread(made, alice, id);
      for (let seq = 0; seq < 8; seq += 1) {
        await messages.upsert(alice, id, message(`m_${seq}`, `body ${seq}`), seq);
      }
      const rows = await made.sql(
        "SELECT count(*)::int AS n FROM vendo_thread_messages WHERE thread_id = $1",
        [id],
      );
      expect(rows[0]!["n"]).toBe(8);
    });
  });

  describe(`${backend.name} v6 message backfill against pre-migration threads`, () => {
    let made: MadeBackend;
    beforeAll(async () => { made = await backend.make(); });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("splits an existing vendo_threads.messages array into one row per message", async () => {
      // Wind a real database back to v5 — the same idiom schema.test.ts uses for
      // the v1 and v2 migrations: drop what v6 added, restore the column v6
      // removed, seed genuine pre-migration threads, then migrate forward.
      await made.store.ensureSchema();
      await made.sql("DROP TABLE vendo_thread_messages");
      await made.sql("ALTER TABLE vendo_threads ADD COLUMN messages jsonb NOT NULL DEFAULT '[]'::jsonb");
      await made.sql("UPDATE vendo_meta SET value = '5'::jsonb WHERE key = 'schema_version'");
      const legacy = [message("m_1", "hello"), message("m_2", "hi there", "assistant"), message("m_3", "bye")];
      await made.sql(
        `INSERT INTO vendo_threads (id, subject, messages, created_at, updated_at)
         VALUES ('thr_legacy', $1, $2::jsonb, now(), now())`,
        [alice.subject, JSON.stringify(legacy)],
      );
      await made.sql(
        `INSERT INTO vendo_threads (id, subject, messages, created_at, updated_at)
         VALUES ('thr_empty', $1, '[]'::jsonb, now(), now())`,
        [bob.subject],
      );

      await made.store.ensureSchema();

      // Every legacy message became a row, in its original array order.
      const rows = await made.sql(
        "SELECT id, seq FROM vendo_thread_messages WHERE thread_id = 'thr_legacy' ORDER BY seq",
      );
      expect(rows.map((r) => [r["id"], Number(r["seq"])])).toEqual([
        ["m_1", 0], ["m_2", 1], ["m_3", 2],
      ]);
      // The helper reads the backfilled history back as UIMessages.
      const listed = await threadMessageStore<UIMessage>(made.store).list(alice, "thr_legacy");
      expect(listed.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"]);
      // An empty thread backfills to nothing, and survives.
      const empty = await made.sql("SELECT count(*)::int AS n FROM vendo_thread_messages WHERE thread_id = 'thr_empty'");
      expect(empty[0]!["n"]).toBe(0);
      const threads = await made.sql("SELECT count(*)::int AS n FROM vendo_threads");
      expect(threads[0]!["n"]).toBe(2);
      // vendo_threads lost `messages` (build contract §6).
      const columns = await made.sql(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'vendo_threads'`,
      );
      expect(columns.map((c) => c["column_name"])).not.toContain("messages");
    });
  });
}

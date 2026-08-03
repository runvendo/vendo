import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { threadStore } from "./index.js";

/**
 * Data-loss regressions found by the independent verifier (findings 3, 4, 5).
 * Every one of these silently DESTROYED a user's words while reporting success.
 */
const alice: Principal = { kind: "user", subject: "user_alice" };

const msg = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

for (const backend of backends()) {
  describe(`${backend.name} v6 backfill preserves every message (finding 3)`, () => {
    let made: MadeBackend;
    beforeAll(async () => { made = await backend.make(); });
    afterAll(async () => { if (made) await made.cleanup(); });

    /** Wind the database back to v5 with a chosen messages array, then migrate. */
    async function migrateWith(messages: unknown[]): Promise<Record<string, unknown>[]> {
      await made.store.ensureSchema();
      await made.sql("DROP TABLE IF EXISTS vendo_thread_messages");
      await made.sql("ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS messages jsonb NOT NULL DEFAULT '[]'::jsonb");
      await made.sql("DELETE FROM vendo_threads");
      await made.sql("UPDATE vendo_meta SET value = '5'::jsonb WHERE key = 'schema_version'");
      await made.sql(
        `INSERT INTO vendo_threads (id, subject, messages, created_at, updated_at)
         VALUES ('thr_x', $1, $2::jsonb, now(), now())`,
        [alice.subject, JSON.stringify(messages)],
      );
      await made.store.ensureSchema();
      return made.sql("SELECT id, seq, message FROM vendo_thread_messages WHERE thread_id = 'thr_x' ORDER BY seq");
    }

    it("keeps BOTH messages when a legacy array repeats an id", async () => {
      // ON CONFLICT DO NOTHING dropped the second one outright.
      const rows = await migrateWith([msg("m_dup", "first"), msg("m_dup", "second")]);

      expect(rows).toHaveLength(2);
      const bodies = rows.map((r) => JSON.stringify(r["message"]));
      expect(bodies.some((b) => b.includes("first"))).toBe(true);
      expect(bodies.some((b) => b.includes("second"))).toBe(true);
    });

    it("keeps both when a real id collides with a derived msg_0", async () => {
      // A message with no id becomes msg_<index>. A REAL message already called
      // msg_0 then collided with it and one of them vanished.
      const rows = await migrateWith([
        { role: "user", parts: [{ type: "text", text: "no id here" }] },
        msg("msg_0", "actually called msg_0"),
      ]);

      expect(rows).toHaveLength(2);
      const bodies = rows.map((r) => JSON.stringify(r["message"]));
      expect(bodies.some((b) => b.includes("no id here"))).toBe(true);
      expect(bodies.some((b) => b.includes("actually called msg_0"))).toBe(true);
    });

    it("preserves the original array ORDER across disambiguated ids", async () => {
      const rows = await migrateWith([msg("a", "one"), msg("a", "two"), msg("b", "three")]);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => Number(r["seq"]))).toEqual([0, 1, 2]);
      expect(rows.map((r) => JSON.parse(JSON.stringify(r["message"])).parts[0].text))
        .toEqual(["one", "two", "three"]);
    });

    it("gives every preserved row a distinct id", async () => {
      const rows = await migrateWith([msg("same", "1"), msg("same", "2"), msg("same", "3")]);
      expect(new Set(rows.map((r) => r["id"])).size).toBe(3);
    });
  });

  describe(`${backend.name} threadStore.put never leaks a driver error (finding 4)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("raises a typed validation error for a duplicate client-minted id, not PG 21000", async () => {
      // A client mints message ids. Two identical ones made the whole write fail
      // with a raw ON CONFLICT cardinality violation and lose the transcript.
      await expect(
        threadStore(made.store).put(alice, {
          id: "thr_dup_ids",
          messages: [msg("m_1", "first"), msg("m_1", "second")],
        }),
      ).rejects.toBeInstanceOf(VendoError);
    });

    it("says which id repeated, so a caller can fix it", async () => {
      await expect(
        threadStore(made.store).put(alice, {
          id: "thr_dup_named",
          messages: [msg("m_clash", "a"), msg("m_clash", "b")],
        }),
      ).rejects.toThrow(/m_clash/);
    });

    it("still accepts a transcript whose ids are distinct", async () => {
      await threadStore(made.store).put(alice, {
        id: "thr_ok_ids",
        messages: [msg("m_1", "a"), msg("m_2", "b")],
      });
      const got = await threadStore(made.store).get(alice, "thr_ok_ids");
      expect(got?.messages).toHaveLength(2);
    });
  });

  describe(`${backend.name} ask_user never reports a write that did not happen (finding 5)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("REFUSES a reused questionId instead of dropping the new answer silently", async () => {
      // The worst shape of the failure: the user's real answer is discarded and a
      // STALE earlier answer stands as though it were theirs, with success
      // reported to the model.
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_reuse", messages: [] });
      await threads.recordAnswer(alice, { threadId: "thr_reuse", questionId: "q_1", answer: { text: "first" } });

      await expect(
        threads.recordAnswer(alice, { threadId: "thr_reuse", questionId: "q_1", answer: { text: "second" } }),
      ).rejects.toBeInstanceOf(VendoError);

      // And the transcript still holds exactly the first answer — not a mix.
      const after = await threads.get(alice, "thr_reuse");
      expect(after?.messages).toHaveLength(1);
      expect(JSON.stringify(after?.messages)).toContain("first");
      expect(JSON.stringify(after?.messages)).not.toContain("second");
    });

    it("names the reused questionId so the caller can tell it apart from a permission failure", async () => {
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_reuse_named", messages: [] });
      await threads.recordAnswer(alice, { threadId: "thr_reuse_named", questionId: "q_7", answer: { text: "x" } });

      await expect(
        threads.recordAnswer(alice, { threadId: "thr_reuse_named", questionId: "q_7", answer: { text: "y" } }),
      ).rejects.toThrow(/q_7/);
    });

    it("records a genuinely new question in the same thread", async () => {
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_two_q", messages: [] });
      await threads.recordAnswer(alice, { threadId: "thr_two_q", questionId: "q_a", answer: { text: "A" } });
      await threads.recordAnswer(alice, { threadId: "thr_two_q", questionId: "q_b", answer: { text: "B" } });

      const after = await threads.get(alice, "thr_two_q");
      expect(after?.messages).toHaveLength(2);
    });
  });
}

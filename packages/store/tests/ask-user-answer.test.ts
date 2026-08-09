import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { threadStore } from "../src/index.js";

/**
 * `ask_user` (design §4) is questions-as-a-tool: one door, any seat. Recording
 * an answer is a WRITE into somebody's thread, so it rides the same
 * subject-scoped gate as every other thread write.
 *
 * These are the security tests for that extension. The threat is specific: an
 * answer arrives from a client, carrying a thread id and an answer body. If the
 * gate trusted either, one person could write into another person's
 * conversation — putting words in their transcript, and (because the transcript
 * is what the next turn reads) steering their agent.
 */
const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

for (const backend of backends()) {
  describe(`${backend.name} ask_user answer gate`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("refuses to record an answer into another subject's thread", async () => {
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_ask_alice", messages: [] });

      await expect(
        threads.recordAnswer(bob, {
          threadId: "thr_ask_alice",
          questionId: "q_1",
          answer: { text: "injected" },
        }),
      ).rejects.toMatchObject<VendoError>({ code: "conflict" });

      // Alice's transcript is untouched — not even an empty row appeared.
      const after = await threads.get(alice, "thr_ask_alice");
      expect(after?.messages).toEqual([]);
    });

    it("refuses an answer for a thread that does not exist, rather than creating one", async () => {
      // A caller must not be able to conjure a thread by answering a question in
      // it: that would let anyone mint rows under any id they like.
      await expect(
        threadStore(made.store).recordAnswer(bob, {
          threadId: "thr_never_existed",
          questionId: "q_1",
          answer: { text: "hello" },
        }),
      ).rejects.toMatchObject<VendoError>({ code: "conflict" });
    });

    it("records the owner's own answer, appended after the existing transcript", async () => {
      const threads = threadStore(made.store);
      await threads.put(alice, {
        id: "thr_ask_ok",
        messages: [{ id: "m_1", role: "assistant", parts: [{ type: "text", text: "Which account?" }] }],
      });

      await threads.recordAnswer(alice, {
        threadId: "thr_ask_ok",
        questionId: "q_1",
        answer: { text: "the savings one" },
      });

      const after = await threads.get(alice, "thr_ask_ok");
      expect(after?.messages).toHaveLength(2);
      expect(JSON.stringify(after?.messages)).toContain("the savings one");
    });

    it("keeps the answer under the ANSWERING principal's subject, never a caller-supplied one", async () => {
      // The written row's ownership comes from the authenticated principal. A
      // `subject` smuggled in the payload must not be honoured.
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_ask_spoof", messages: [] });

      await threads.recordAnswer(alice, {
        threadId: "thr_ask_spoof",
        questionId: "q_1",
        answer: { text: "mine", subject: bob.subject },
      });

      const rows = await made.sql(
        "SELECT subject FROM vendo_threads WHERE id = $1",
        ["thr_ask_spoof"],
      );
      expect(rows[0]!["subject"]).toBe(alice.subject);
      expect(await threads.get(bob, "thr_ask_spoof")).toBeNull();
    });

    it("does not silently swallow an answer whose questionId collides with an unrelated message", async () => {
      // Found by the in-lane security review. `questionId` is client-controlled
      // and used to share a primary key with EVERY message in the thread, so an
      // answer whose id happened to match an ordinary assistant message hit
      // ON CONFLICT DO NOTHING, wrote nothing, and still reported success.
      const threads = threadStore(made.store);
      await threads.put(alice, {
        id: "thr_ask_collide",
        messages: [{ id: "m_existing", role: "assistant", parts: [{ type: "text", text: "Which one?" }] }],
      });

      await threads.recordAnswer(alice, {
        threadId: "thr_ask_collide",
        questionId: "m_existing",
        answer: { text: "the second" },
      });

      const after = await threads.get(alice, "thr_ask_collide");
      expect(after?.messages).toHaveLength(2);
      expect(JSON.stringify(after?.messages)).toContain("the second");
      // The pre-existing message is intact, not overwritten.
      expect(JSON.stringify(after?.messages)).toContain("Which one?");
    });

    it("reassembles deterministically even when two messages share a seq", async () => {
      // Also from the review: `seq` is assigned as max(seq)+1 with no unique
      // constraint, so concurrent writers can tie. A tie must still produce ONE
      // stable order, or the transcript the next turn reads is nondeterministic.
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_ask_tie", messages: [] });
      await made.sql(
        `INSERT INTO vendo_thread_messages (thread_id, id, seq, message)
         VALUES ('thr_ask_tie', 'm_b', 0, '{"id":"m_b"}'::jsonb),
                ('thr_ask_tie', 'm_a', 0, '{"id":"m_a"}'::jsonb)`,
      );

      const first = await threads.get(alice, "thr_ask_tie");
      const second = await threads.get(alice, "thr_ask_tie");

      expect(first?.messages).toEqual(second?.messages);
      expect((first?.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m_a", "m_b"]);
    });

    it("refuses a second answer to the same question, and does not duplicate the row", async () => {
      // This test previously asserted that answering twice SILENTLY succeeded,
      // treating it as idempotency. The independent verifier showed that is the
      // data-loss bug: the second answer is a different answer, so swallowing it
      // discards the user's words and leaves the first standing as theirs. The
      // no-duplicate-row half was right and still holds; the silence was not.
      const threads = threadStore(made.store);
      await threads.put(alice, { id: "thr_ask_twice", messages: [] });

      await threads.recordAnswer(alice, { threadId: "thr_ask_twice", questionId: "q_7", answer: { text: "yes" } });
      await expect(
        threads.recordAnswer(alice, { threadId: "thr_ask_twice", questionId: "q_7", answer: { text: "no" } }),
      ).rejects.toMatchObject<VendoError>({ code: "conflict" });

      const after = await threads.get(alice, "thr_ask_twice");
      expect(after?.messages).toHaveLength(1);
      expect(JSON.stringify(after?.messages)).toContain("yes");
    });
  });
}

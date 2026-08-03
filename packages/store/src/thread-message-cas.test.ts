import { VendoError, type Principal } from "@vendoai/core";
import type { UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { threadMessageStore, threadStore } from "./index.js";

/** Findings 9 and 10 — the helper's ordering disagreed with the door's, and its
 *  comment promised a per-row CAS that did not exist. */
const alice: Principal = { kind: "user", subject: "user_alice" };
const message = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

for (const backend of backends()) {
  describe(`${backend.name} thread-message ordering matches the door (finding 9)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("breaks a seq tie the SAME way the reserved-collection door does", async () => {
      // The door orders by (seq, id) and calls that tie-break load-bearing. The
      // helper ordered by seq alone, so lane A's runtime and the door could read
      // one thread in two different orders.
      await threadStore(made.store).put(alice, { id: "thr_tie", messages: [] });
      await made.sql(
        `INSERT INTO vendo_thread_messages (thread_id, id, seq, message)
         VALUES ('thr_tie', 'm_b', 0, '{"id":"m_b"}'::jsonb),
                ('thr_tie', 'm_a', 0, '{"id":"m_a"}'::jsonb)`,
      );

      const viaHelper = (await threadMessageStore<UIMessage>(made.store).list(alice, "thr_tie")).map((m) => m.id);
      const viaDoor = ((await threadStore(made.store).get(alice, "thr_tie"))?.messages ?? [])
        .map((m) => (m as { id: string }).id);

      expect(viaHelper).toEqual(viaDoor);
      expect(viaHelper).toEqual(["m_a", "m_b"]);
    });
  });

  describe(`${backend.name} per-row CAS on revision (finding 10, contract §6)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("accepts an edit that carries the CURRENT revision", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      await threadStore(made.store).put(alice, { id: "thr_cas_ok", messages: [] });
      await messages.upsert(alice, "thr_cas_ok", message("m_1", "before"), 0);

      await messages.upsert(alice, "thr_cas_ok", message("m_1", "after"), 0, { expectedRevision: 1 });

      expect(JSON.stringify(await messages.list(alice, "thr_cas_ok"))).toContain("after");
    });

    it("REFUSES an edit built on a stale revision, so a lost update is impossible", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      await threadStore(made.store).put(alice, { id: "thr_cas_stale", messages: [] });
      await messages.upsert(alice, "thr_cas_stale", message("m_1", "v1"), 0);
      // Someone else lands an edit; the row is now at revision 2.
      await messages.upsert(alice, "thr_cas_stale", message("m_1", "v2"), 0);

      await expect(
        messages.upsert(alice, "thr_cas_stale", message("m_1", "v3-from-stale-read"), 0, { expectedRevision: 1 }),
      ).rejects.toBeInstanceOf(VendoError);

      // The winner's content survives; the stale writer clobbered nothing.
      expect(JSON.stringify(await messages.list(alice, "thr_cas_stale"))).toContain("v2");
    });

    it("refuses an expectedRevision for a message that does not exist yet", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      await threadStore(made.store).put(alice, { id: "thr_cas_absent", messages: [] });

      await expect(
        messages.upsert(alice, "thr_cas_absent", message("m_ghost", "x"), 0, { expectedRevision: 1 }),
      ).rejects.toBeInstanceOf(VendoError);
    });

    it("still allows a plain upsert with no expectation, as the contract's default", async () => {
      const messages = threadMessageStore<UIMessage>(made.store);
      await threadStore(made.store).put(alice, { id: "thr_cas_default", messages: [] });
      await messages.upsert(alice, "thr_cas_default", message("m_1", "a"), 0);
      await messages.upsert(alice, "thr_cas_default", message("m_1", "b"), 0);

      expect(JSON.stringify(await messages.list(alice, "thr_cas_default"))).toContain("b");
    });
  });
}

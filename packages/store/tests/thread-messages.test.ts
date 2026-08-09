import { VendoError, type Json, type Principal } from "@vendoai/core";
import type { UIMessage } from "ai";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { harnessStateKey } from "../src/harness-state.js";
import { createStore, eraseStore, storeFiles, threadMessageStore, threadStore } from "../src/index.js";
import type { VendoStore } from "../src/store.js";

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

    it("deletes the thread's message rows with the thread, leaving nothing erase cannot reach", async () => {
      // A message row carries no subject of its own — the thread row IS the
      // ownership record — so a message left behind by a thread delete is
      // unreachable by `erase.bySubject`, which finds it only through
      // `thread_id IN (SELECT id FROM vendo_threads WHERE subject = $1)`.
      const id = "thr_deleted";
      await ownThread(made, alice, id);
      await threadMessageStore<UIMessage>(made.store).upsert(alice, id, message("m_1", "private"), 0);

      await threadStore(made.store).delete(alice, id);

      const left = await made.sql(
        "SELECT count(*)::int AS n FROM vendo_thread_messages WHERE thread_id = $1",
        [id],
      );
      expect(left[0]!["n"]).toBe(0);
    });

    it("keeps a foreign principal's failed delete from touching the thread's message rows", async () => {
      const id = "thr_delete_guard";
      await ownThread(made, alice, id);
      await threadMessageStore<UIMessage>(made.store).upsert(alice, id, message("m_1", "mine"), 0);

      await threadStore(made.store).delete(bob, id);

      const left = await made.sql(
        "SELECT count(*)::int AS n FROM vendo_thread_messages WHERE thread_id = $1",
        [id],
      );
      expect(left[0]!["n"]).toBe(1);
    });

    it("derives every row id once, so an empty-string id cannot collide inside the statement", async () => {
      // The duplicate guard runs on the TypeScript derivation; the INSERT used a
      // separate SQL COALESCE that disagreed with it. `elem->>'id'` yields '' for
      // {"id":""} rather than NULL, so two such messages passed the guard as
      // msg_0/msg_1 and then hit ON CONFLICT twice with the same key '' — a bare
      // Postgres 21000 cardinality violation that lost the whole write.
      const id = "thr_blank_ids";
      await threadStore(made.store).put(alice, {
        id,
        messages: [message("", "first"), message("", "second")] as unknown as Json[],
      });

      const rows = await made.sql(
        "SELECT id, seq FROM vendo_thread_messages WHERE thread_id = $1 ORDER BY seq",
        [id],
      );
      expect(rows.map((row) => row["id"])).toEqual(["msg_0", "msg_1"]);
    });

    it("derives every row id once, so a non-string id cannot collide with its own text form", async () => {
      // `elem->>'id'` renders {"id":5} as '5', which the TypeScript rule never
      // produces — so [{id:5},{id:"5"}] cleared the guard and collided in SQL.
      const id = "thr_numeric_ids";
      await threadStore(made.store).put(alice, {
        id,
        messages: [
          { id: 5, role: "user", parts: [{ type: "text", text: "numeric" }] },
          { id: "5", role: "user", parts: [{ type: "text", text: "textual" }] },
        ] as unknown as Json[],
      });

      const rows = await made.sql(
        "SELECT id, seq FROM vendo_thread_messages WHERE thread_id = $1 ORDER BY seq",
        [id],
      );
      expect(rows.map((row) => row["id"])).toEqual(["msg_0", "5"]);
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

/**
 * The cascade under CONCURRENCY.
 *
 * `threadStore.delete` is one transaction, but a transcript writer that only
 * READS the thread row takes no lock on it. Under READ COMMITTED its snapshot
 * still shows that row while the delete sits uncommitted, so it appends a
 * message the cascade has already swept past — and the row outlives the thread
 * that owns it. That row is then unreachable forever, for exactly the reason
 * the cascade above exists: no foreign key, no subject of its own, and
 * `erase.bySubject` reaches transcript rows only through `thread_id IN (SELECT
 * id FROM vendo_threads WHERE subject = $1)`.
 *
 * PGlite cannot show this — it is single-connection and serializes
 * transactions, so the interleave is unreachable there. Real Postgres only,
 * which the store shards already set POSTGRES_URL for.
 *
 * The overlap is FORCED, not raced: a third connection holds the `vendo_state`
 * row the cascade deletes LAST, so the delete parks with the thread row already
 * gone and not yet committed — precisely the window that strands a row.
 */
describe.runIf(process.env["POSTGRES_URL"])("a concurrent transcript write cannot escape the cascade", () => {
  const url = process.env["POSTGRES_URL"]!;
  let store: VendoStore;
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    store = createStore({ url });
    await store.ensureSchema();
  });
  afterAll(async () => {
    if (store) await store.close();
    if (admin) await admin.end();
  });

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll until `ready`. The attempt bound is a safety net far inside the
   *  suite's own timeout, so the test timeout stays the only hang detector. */
  const until = async (ready: () => Promise<boolean>): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await ready()) return;
      await wait(25);
    }
    throw new Error("the forced overlap never opened");
  };

  const blockedOn = async (table: string): Promise<boolean> => (
    await admin.query(
      `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'`,
      [table],
    )
  ).rows.length > 0;

  /** An owned thread with one message, plus the harness-state row the cascade
   *  deletes last — that row is the parking brake. */
  const seed = async (id: string): Promise<void> => {
    await threadStore(store).put(alice, { id, messages: [] });
    await threadMessageStore<UIMessage>(store).upsert(alice, id, message("m_seed", "before"), 0);
    await admin.query(
      `INSERT INTO vendo_state (app_id, subject, data, created_at, updated_at)
       VALUES ($1, $2, '{}'::jsonb, now(), now())`,
      [harnessStateKey(id), alice.subject],
    );
  };

  /** Run `write` while the cascade is parked, then let the cascade finish.
   *  Resolves to "ok" when the write reported success to its caller. */
  const duringCascade = async (id: string, write: () => Promise<unknown>): Promise<string> => {
    const brake = new Client({ connectionString: url });
    await brake.connect();
    await brake.query("BEGIN");
    await brake.query("SELECT 1 FROM vendo_state WHERE app_id = $1 FOR UPDATE", [harnessStateKey(id)]);

    const deleting = threadStore(store).delete(alice, id);
    await until(() => blockedOn("vendo_state"));

    let settled = false;
    const writing = write()
      .then(() => "ok", (error: unknown) => String(error))
      .finally(() => { settled = true; });
    // The write has either finished (it escaped) or parked on the thread row's
    // own lock (it did not). Either way the window is open; release the brake.
    await until(async () => settled || await blockedOn("vendo_thread_messages"));

    await brake.query("ROLLBACK");
    await brake.end();
    const outcome = await writing;
    await deleting;
    return outcome;
  };

  const survivingMessages = async (id: string): Promise<number> => (
    await admin.query("SELECT id FROM vendo_thread_messages WHERE thread_id = $1", [id])
  ).rows.length;

  it("refuses an ask_user answer written into a thread the cascade is deleting", async () => {
    const id = "thr_race_answer";
    await seed(id);

    const outcome = await duringCascade(id, () => threadStore(store).recordAnswer(alice, {
      threadId: id,
      questionId: "q_race",
      answer: { picked: "yes" },
    }));

    // Reporting success is the worse half of the bug: `recordAnswer`'s contract
    // is that a receipt means the row exists, and the model reads that receipt.
    expect(outcome).not.toBe("ok");
    expect(await survivingMessages(id)).toBe(0);
  });

  it("refuses a message upsert written into a thread the cascade is deleting", async () => {
    const id = "thr_race_upsert";
    await seed(id);

    const outcome = await duringCascade(
      id,
      () => threadMessageStore<UIMessage>(store).upsert(alice, id, message("m_race", "during"), 1),
    );

    expect(outcome).not.toBe("ok");
    expect(await survivingMessages(id)).toBe(0);
  });
});

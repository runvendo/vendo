/**
 * `upsertMany` — a turn's messages in ONE write, proven at the SEAM.
 *
 * Both halves of the transcript helper sit on the SAME real database here: the
 * SQL half through `made.store`, the ops half through `createStoreOps` over
 * that same store. So a batch written by one is read back by the other through
 * its own real read path, with nothing stubbed on either side — the only way
 * this file can catch the two disagreeing.
 *
 * The third mode is the console the op predates. It is spelled the way an old
 * console actually answers (a `/status` op count from before the op, and a
 * `not-implemented` for the route itself), not as a stub of our own code, so
 * the feature detect has a real skew to detect.
 */
import { VENDO_STORE_WIRE_FORMAT, VendoError, type Principal, type StoreOps } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import {
  createStoreOps,
  threadMessageStore,
  threadStore,
  type ThreadMessageLike as UIMessage,
  type VendoStore,
} from "../src/index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

const message = (id: string, text: string, role: "user" | "assistant" = "user"): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

/** A store the way a HOST supplies one: the public surface plus a StoreOps, and
 *  no handle this package minted — the shape the Cloud hosted store presents. */
function opsOnlyStore(ops: StoreOps): VendoStore {
  const unused = (what: string): never => {
    throw new Error(`the transcript helper must not reach ${what}`);
  };
  return {
    ops,
    records: () => unused("records()"),
    blobs: () => unused("blobs()"),
    async ensureSchema() {},
    async close() {},
    raw: () => unused("raw()"),
  };
}

/** The console as it answers BEFORE `transcripts.appendMessages` shipped: the
 *  handshake reports the older op count, and the route itself is an enveloped
 *  `not-implemented`. Everything else is the real implementation. */
function consoleBeforeAppendMessages(ops: StoreOps): StoreOps {
  return {
    ...ops,
    transcripts: {
      ...ops.transcripts,
      appendMessages: () => Promise.reject(
        new VendoError("not-implemented", "Unknown store operation: transcripts.appendMessages"),
      ),
    },
    status: async () => ({ format: VENDO_STORE_WIRE_FORMAT, ops: 35 }),
  };
}

for (const backend of backends()) {
  describe(`${backend.name} transcript batch append (design 4a)`, () => {
    let made: MadeBackend;
    /** Every mode writes to and reads from the one database below. */
    let modes: Array<{ name: string; store: VendoStore }>;
    const own = async (id: string, subject: string): Promise<void> => {
      await threadStore(made.store).put({ kind: "user", subject }, { id, messages: [] });
    };
    const pick = (name: string): VendoStore => modes.find((mode) => mode.name === name)!.store;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      const ops = createStoreOps(made.store);
      modes = [
        { name: "sql", store: made.store },
        { name: "ops", store: opsOnlyStore(ops) },
        { name: "old-console", store: opsOnlyStore(consoleBeforeAppendMessages(ops)) },
      ];
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    /** The same turn shape every mode writes: three messages, then one edit
     *  plus one new message — the approval flip and its follow-up. */
    const writeTurns = async (store: VendoStore, thread: string): Promise<void> => {
      const messages = threadMessageStore<UIMessage>(store);
      await messages.upsertMany(alice, thread, [
        message("m_1", "book me a table"),
        message("m_2", "which night?", "assistant"),
        message("m_3", "friday"),
      ], { title: "book me a table" });
      await messages.upsertMany(alice, thread, [
        message("m_2", "friday it is", "assistant"),
        message("m_4", "booked", "assistant"),
      ]);
    };

    it("the ops path and the SQL path land byte-identical transcripts", async () => {
      await own("thr_batch_sql", alice.subject);
      await own("thr_batch_ops", alice.subject);
      await writeTurns(pick("sql"), "thr_batch_sql");
      await writeTurns(pick("ops"), "thr_batch_ops");

      // Read BOTH threads back through BOTH read paths: same rows, same order,
      // whichever half wrote them and whichever half reads them.
      const read = async (store: VendoStore, thread: string): Promise<string> =>
        JSON.stringify(await threadMessageStore<UIMessage>(store).list(alice, thread));
      const viaSqlOfSql = await read(pick("sql"), "thr_batch_sql");
      const viaSqlOfOps = await read(pick("sql"), "thr_batch_ops");
      const viaOpsOfSql = await read(pick("ops"), "thr_batch_sql");
      const viaOpsOfOps = await read(pick("ops"), "thr_batch_ops");

      expect(JSON.parse(viaSqlOfSql).map((m: UIMessage) => m.id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
      expect(viaSqlOfSql).toContain("friday it is");
      expect(viaSqlOfOps).toBe(viaSqlOfSql);
      expect(viaOpsOfSql).toBe(viaSqlOfSql);
      expect(viaOpsOfOps).toBe(viaSqlOfSql);
    });

    it("both halves refuse a foreign subject and write nothing", async () => {
      await own("thr_batch_foreign", alice.subject);
      const alicesMessages = threadMessageStore<UIMessage>(pick("sql"));
      await alicesMessages.upsertMany(alice, "thr_batch_foreign", [message("m_1", "mine")]);

      for (const mode of ["sql", "ops"] as const) {
        const messages = threadMessageStore<UIMessage>(pick(mode));
        await expect(
          messages.upsertMany(bob, "thr_batch_foreign", [message("m_bob", "yours")]),
          mode,
        ).rejects.toBeInstanceOf(VendoError);
      }
      expect(await alicesMessages.list(alice, "thr_batch_foreign")).toHaveLength(1);
    });

    it("a console that predates the op takes the older route to the same transcript", async () => {
      await own("thr_batch_skew", alice.subject);
      await writeTurns(pick("old-console"), "thr_batch_skew");

      // The fallback wrote through getThread + putMessage; the read path is the
      // real one either way, and the transcript has to match the native op's.
      await own("thr_batch_native", alice.subject);
      await writeTurns(pick("ops"), "thr_batch_native");
      const read = async (thread: string): Promise<unknown[]> =>
        await threadMessageStore<UIMessage>(pick("sql")).list(alice, thread);
      expect(JSON.stringify(await read("thr_batch_skew"))).toBe(JSON.stringify(await read("thr_batch_native")));
    });

    /**
     * TWO TURNS, ONE CONVERSATION — the seam this whole op sits on.
     *
     * `seq` carries the conversation's order, and it has no unique constraint
     * (THREAD_MESSAGES_AGGREGATE says so): equal seqs make the transcript fall
     * back to ordering by message ID, which is not turn order. A conversation
     * that reads back scrambled is a broken product, and it would be
     * intermittent and near-undiagnosable in the field.
     *
     * PGlite cannot prove anything here — it is one connection, so nothing
     * interleaves. This needs genuine concurrent backends, so it runs on the
     * postgres leg only (POSTGRES_URL).
     */
    /**
     * EVERY transcript writer that allocates a position, raced against the batch
     * append — not just the batch path against itself. The first round of this
     * test only paired `appendMessages` with `appendMessages`, and that is
     * precisely why it missed the same bug living in `putMessage` and
     * `recordAnswer`: a race test proves only the pairing it actually runs.
     */
    const rivals = [
      {
        name: "appendMessages",
        // Not pre-created: round 0 then races on a thread that does NOT exist
        // yet, covering the create path (two writers conflicting on the primary
        // key) alongside the update path (two queuing on the row lock).
        seeded: false,
        write: (ops: StoreOps, thread: string, round: number) =>
          ops.transcripts.appendMessages!(thread, alice.subject, [message(`m_${round}_b`, "rival")]),
      },
      {
        name: "putMessage",
        seeded: true,
        write: (ops: StoreOps, thread: string, round: number) =>
          ops.transcripts.putMessage(thread, message(`m_${round}_b`, "rival")),
      },
      {
        name: "recordAnswer",
        seeded: true,
        write: (ops: StoreOps, thread: string, round: number) =>
          ops.transcripts.recordAnswer(thread, { id: `m_${round}_b`, value: round }),
      },
    ];

    for (const rival of rivals) {
      it.runIf(backend.name === "postgres")(
        `appendMessages racing ${rival.name} never shares a seq`,
        async () => {
          const ops = createStoreOps(made.store);
          const thread = `thr_race_${rival.name.toLowerCase()}`;
          const ROUNDS = 20;
          if (rival.seeded) {
            await ops.transcripts.putThread({ id: thread, subject: alice.subject, messages: [] });
          }
          for (let round = 0; round < ROUNDS; round += 1) {
            await Promise.all([
              ops.transcripts.appendMessages!(thread, alice.subject, [message(`m_${round}_a`, "batch")]),
              rival.write(ops, thread, round),
            ]);
          }

          const rows = await made.sql(
            "SELECT id, seq FROM vendo_thread_messages WHERE thread_id = $1 ORDER BY seq ASC, id ASC",
            [thread],
          );
          expect(rows).toHaveLength(ROUNDS * 2);
          const seqs = rows.map((row) => Number(row["seq"]));
          // THE claim: a seq identifies one position in the conversation.
          expect(new Set(seqs).size, `duplicate seqs: ${JSON.stringify(seqs)}`).toBe(seqs.length);

          // And the read-back order is the true append order: the two racers
          // within a round may land either way round, but round k must precede
          // round k+1. (`recordAnswer` prefixes its row id, so the round is read
          // off the first digits rather than a fixed segment.)
          const listed = await threadMessageStore<UIMessage>(pick("sql")).list(alice, thread);
          const rounds = listed.map((m) => Number(/(\d+)/.exec(m.id)![1]));
          expect(rounds, `transcript out of turn order: ${listed.map((m) => m.id).join(",")}`)
            .toEqual([...rounds].sort((left, right) => left - right));
        },
      );
    }

    it("answers with the revision and the row count, never the transcript", async () => {
      await own("thr_batch_payload", alice.subject);
      const ops = createStoreOps(made.store);
      const answer = await ops.transcripts.appendMessages!("thr_batch_payload", alice.subject, [
        message("m_1", "one"),
        message("m_2", "two"),
      ]);

      // The whole point of the op: what comes back does not grow with the
      // conversation, so the tenth turn costs exactly what the first did.
      expect(Object.keys(answer).sort()).toEqual(["count", "revision"]);
      expect(answer.count).toBe(2);
      const again = await ops.transcripts.appendMessages!("thr_batch_payload", alice.subject, [
        message("m_3", "three"),
      ]);
      expect(JSON.stringify(again).length).toBeLessThanOrEqual(JSON.stringify(answer).length + 2);
    });
  });
}

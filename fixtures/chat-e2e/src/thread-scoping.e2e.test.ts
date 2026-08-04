/** Scenario 7 — THREAD PERSISTENCE + SCOPING through the real store.
 *
 * A turn persists exactly one vendo_threads row for the subject (03 §5, 02 §2).
 * Subject B cannot get, list, or delete subject A's thread, and SQL confirms
 * the row's subject column. This is the integration that only works once the
 * agent keys reserved vendo_threads rows by the bare thread id and enforces
 * subject scoping on read/delete (the bug this wave fixed in @vendoai/agent).
 */
import { threadStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnv,
  descriptor,
  readSse,
  scriptedModel,
  SpyRegistry,
  textTurn,
  userCtx,
  userMessage,
  type Env,
} from "./harness.js";

const ADA = "user_ada";
const BOB = "user_bob";
const THREAD = "thr_scoped";

/** The transcript, reassembled by seq, as a `messages` column.
 *
 *  Build contract §6 moved the transcript out of `vendo_threads.messages` (the
 *  column is DROPPED) into one row per message in `vendo_thread_messages`. The
 *  SQL proof below is unchanged in what it proves — the owner's transcript is
 *  byte-for-byte intact after a foreign subject is refused — only in where it
 *  reads it from. Ordering is `(seq, id)`, matching `THREAD_MESSAGES_AGGREGATE`
 *  in the store exactly, so this reads a thread in the same order the store's
 *  own door does. */
const TRANSCRIPT = `(SELECT jsonb_agg(m.message ORDER BY m.seq, m.id)
     FROM vendo_thread_messages m WHERE m.thread_id = t.id) AS messages`;

let env: Env;
afterEach(async () => {
  await env?.close();
});

describe("scenario 7: thread persistence + subject scoping", () => {
  it("persists one row for the subject and never lets another subject read or delete it", async () => {
    env = await createEnv();
    const registry = new SpyRegistry([descriptor({ name: "host_noop", risk: "read" })]);

    // Ada runs a turn; it persists exactly one vendo_threads row.
    const agentAda = env.agentFor(registry, scriptedModel([textTurn("Hello Ada.", "t1")]));
    const ctxAda = userCtx(ADA);
    await readSse(
      await agentAda.stream({ threadId: THREAD, message: userMessage("u1", "Hi"), ctx: ctxAda }),
    );

    const rows = await env.sql<{ id: string; subject: string }>(
      "SELECT id, subject FROM vendo_threads",
    );
    expect(rows).toEqual([{ id: THREAD, subject: ADA }]);
    const stored = await agentAda.threads.get(THREAD, ctxAda);
    expect(stored).toMatchObject({ id: THREAD, subject: ADA });
    expect(await agentAda.threads.list(ctxAda)).toHaveLength(1);

    // Bob — a separate subject, separate agent instance over the same store —
    // cannot get, list, or delete Ada's thread.
    const agentBob = env.agentFor(registry, scriptedModel([textTurn("unused", "t2")]));
    const ctxBob = userCtx(BOB);
    expect(await agentBob.threads.get(THREAD, ctxBob)).toBeNull();
    expect(await agentBob.threads.list(ctxBob)).toEqual([]);

    await agentBob.threads.delete(THREAD, ctxBob); // no-op: not Bob's thread
    // Ada's thread survives untouched; the row (and its subject) is unchanged.
    expect(await agentAda.threads.get(THREAD, ctxAda)).toMatchObject({ id: THREAD, subject: ADA });
    const after = await env.sql<{ id: string; subject: string }>(
      "SELECT id, subject FROM vendo_threads",
    );
    expect(after).toEqual([{ id: THREAD, subject: ADA }]);
  });

  it("refuses a foreign subject streaming to an existing thread id — conflict, row intact (no takeover)", async () => {
    env = await createEnv();
    const registry = new SpyRegistry([descriptor({ name: "host_noop", risk: "read" })]);
    const THR = "thr_takeover_target";

    // Ada owns thr_takeover_target on disk.
    const agentAda = env.agentFor(registry, scriptedModel([textTurn("Ada's turn.", "t1")]));
    const ctxAda = userCtx(ADA);
    await readSse(
      await agentAda.stream({ threadId: THR, message: userMessage("u1", "Ada's message"), ctx: ctxAda }),
    );
    const before = await env.sql<{ id: string; subject: string; messages: unknown }>(
      `SELECT t.id, t.subject, ${TRANSCRIPT} FROM vendo_threads t WHERE t.id = $1`,
      [THR],
    );
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: THR, subject: ADA });
    // Ada's transcript really is on disk, so the "intact afterwards" comparison
    // below cannot pass vacuously on two empty reads.
    expect(JSON.stringify(before[0]!.messages)).toContain("Ada's message");

    // Bob streaming to the SAME id must be refused before any turn runs —
    // without this, the turn's persist() would upsert the bare-id row and
    // overwrite Ada's subject + messages (03 §5).
    const agentBob = env.agentFor(registry, scriptedModel([textTurn("Bob's turn.", "t2")]));
    await expect(
      agentBob.stream({ threadId: THR, message: userMessage("u2", "Bob's takeover"), ctx: userCtx(BOB) }),
    ).rejects.toMatchObject({ code: "conflict" });

    // SQL: Ada's row is INTACT — same subject, same messages — and Bob wrote nothing.
    const after = await env.sql<{ id: string; subject: string; messages: unknown }>(
      `SELECT t.id, t.subject, ${TRANSCRIPT} FROM vendo_threads t WHERE t.id = $1`,
      [THR],
    );
    expect(after).toEqual(before);
    expect(JSON.stringify(after[0]!.messages)).not.toContain("Bob's takeover");
    expect(await env.count("vendo_threads", "subject = $1", [BOB])).toBe(0);
    expect(await env.count("vendo_threads")).toBe(1);
  });

  it("refuses a PERSIST-TIME cross-subject takeover atomically at the store door (B1)", async () => {
    env = await createEnv();
    const THR = "thr_persist_race";

    // Ada owns the row on disk (the victim that appears/exists when persist runs,
    // even if a resolve()-time pre-check had passed for a now-stale view).
    await threadStore(env.store).put(userCtx(ADA).principal, {
      id: THR,
      messages: [{ role: "user", parts: [{ type: "text", text: "Ada's message" }] }],
    });

    // Bob's persist writing the SAME bare id must be refused by the store's guarded
    // upsert — the TOCTOU window a resolve()-time check alone cannot close.
    await expect(
      threadStore(env.store).put(userCtx(BOB).principal, {
        id: THR,
        messages: [{ role: "user", parts: [{ type: "text", text: "Bob's takeover" }] }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // SQL proof: Ada's row is untouched, Bob owns nothing.
    const rows = await env.sql<{ subject: string; messages: unknown }>(
      `SELECT t.subject, ${TRANSCRIPT} FROM vendo_threads t WHERE t.id = $1`,
      [THR],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe(ADA);
    // Ada's transcript is still exactly what she wrote — not merely "a row exists".
    expect(rows[0]!.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "Ada's message" }] },
    ]);
    expect(JSON.stringify(rows[0]!.messages)).not.toContain("Bob's takeover");
    expect(await env.count("vendo_threads", "subject = $1", [BOB])).toBe(0);
  });

  it("returns ALL of a subject's threads past the store's page cap, most-recently-updated first (M4)", async () => {
    env = await createEnv();
    const CARL = "user_carl";
    const principal = userCtx(CARL).principal;
    const store = threadStore(env.store);

    // One OLD-created thread, then 120 newer ones (past the 100-row page cap). The
    // old one is created FIRST, so it sorts last by created_at — on page 2+.
    await store.put(principal, { id: "thr_oldest", messages: [{ role: "user", parts: [{ type: "text", text: "oldest" }] }] });
    await new Promise<void>((r) => setTimeout(r, 3));
    for (let i = 0; i < 120; i += 1) {
      await store.put(principal, {
        id: `thr_${String(i).padStart(3, "0")}`,
        messages: [{ role: "user", parts: [{ type: "text", text: `filler ${i}` }] }],
      });
    }
    // Now TOUCH the oldest thread so it becomes the most recently UPDATED — the
    // exact "old-created, recently-active" thread the cursor-truncation bug hid.
    await new Promise<void>((r) => setTimeout(r, 3));
    await store.put(principal, { id: "thr_oldest", messages: [{ role: "user", parts: [{ type: "text", text: "touched" }] }] });

    const summaries = await env.agentFor(new SpyRegistry([]), scriptedModel([]))
      .threads.list(userCtx(CARL));

    // All 121 threads come back (nothing truncated at the page boundary)...
    expect(summaries).toHaveLength(121);
    // ...and the recently-touched old thread is first (list re-sorts by updatedAt).
    expect(summaries[0]!.id).toBe("thr_oldest");
    expect(new Set(summaries.map((s) => s.id)).size).toBe(121);
  });
});

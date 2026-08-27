import { VendoError, type StoreOps } from "@vendoai/core";
import type { Db } from "./db-postgres.js";
import { backendOf } from "./helpers/backend.js";
import type { VendoStore } from "./store.js";

/**
 * Build contract §1.3 — `turn.state`, made durable.
 *
 * The runtime ships a process-lifetime reference implementation, which is
 * honest for a disposable session id and useless for a session-OWNING harness:
 * `claudeCode()` reads its native session on the turn AFTER the one that wrote
 * it, so a restart (or a second replica) meant a re-seed on every turn.
 *
 * The state lives on the THREAD ROW — `vendo_threads.harness_state` (v12) — and
 * that is the whole design. It rode `vendo_state` under a synthetic `app_id`
 * before, which bought "no new table" at the price of a slot no table cascade
 * covered: thread deletion swept it by hand in two places, a retention sweep
 * needed a fence to keep the app-state door from seeing it, and the erase
 * cascade reached it only through a second selector. On the thread row, every
 * one of those is simply the row going away.
 *
 * ONE slot per thread carrying its owner's name, exactly as the interface says:
 * a foreign harness DESTROYS the row rather than shadowing it, so swapping back
 * cannot resurrect a session the conversation has outgrown.
 *
 * Typed structurally rather than against `HarnessStateStore` because the store
 * sits BELOW `@vendoai/harnesses` in the layering (contract §2) — the shape is
 * the contract, as it is for `threadMessageStore`.
 */
/** The slot's stored payload. Spelled ONCE because three writers land it: both
 *  backends' `set`, and a batched turn commit, which carries the row itself
 *  rather than calling `set` — a second spelling would be a slot one writer
 *  could no longer read. */
export const harnessStateRow = (harnessName: string, value: string): { harness: string; value: string } =>
  ({ harness: harnessName, value });

export interface HarnessStateStore {
  /** `owner` is the thread row's own `subject`, passed when the caller has
   *  ALREADY read the row this verb would otherwise re-fetch to learn it (the
   *  ops backend's `ownerOf` is one wire round-trip per verb). It is a
   *  shortcut, never an assertion: a wrong owner reads as a missing slot, so
   *  callers pass only what a thread read actually returned. */
  get(threadId: string, harnessName: string, owner?: string): Promise<string | undefined>;
  /** `get` for a caller that ALREADY holds the slot's stored value — the turn
   *  envelope reads it in the same call as the thread. Same rules as `get`,
   *  because it is `get`'s second half: a slot belonging to another harness is
   *  still destroyed rather than shadowed (§1.3). `stored` is the raw row
   *  payload `harness.get` answers; `undefined` is a missing slot. */
  resume(threadId: string, harnessName: string, stored: unknown, owner?: string): Promise<string | undefined>;
  set(threadId: string, harnessName: string, value: string | undefined, owner?: string): Promise<void>;
  clear(threadId: string, owner?: string): Promise<void>;
}

/** The one row's payload, whichever backend holds it. */
interface StoredState {
  harness?: unknown;
  value?: unknown;
}

/** Rows come back as jsonb (an object) or as text, depending on the driver. */
function decode(row: unknown): StoredState | undefined {
  if (row === null || row === undefined) return undefined;
  const stored = typeof row === "string" ? (JSON.parse(row) as unknown) : row;
  if (typeof stored !== "object" || stored === null) return undefined;
  return stored as StoredState;
}

export function harnessStateStore(store: VendoStore): HarnessStateStore {
  const backend = backendOf(store, "durable harness state (build contract §1.3)");
  return backend.kind === "ops" ? overOps(backend.ops) : overSql(backend.db);
}

/**
 * The hosted half: the SAME slot — the thread's id, the thread's owner as the
 * subject — served by the wire's `harness` family, so a deployment can move
 * between backends without its sessions changing shape.
 *
 * The owner comes from `transcripts.getThread` where SQL reads `vendo_threads`
 * directly. That read is not decoration: the wire's harness verbs are keyed by
 * (threadId, subject), and a mount answers a subject that is not the thread's
 * own as an empty slot — the same rule the SQL half enforces in its WHERE.
 */
function overOps(ops: StoreOps): HarnessStateStore {
  const ownerOf = async (threadId: string): Promise<string | undefined> => {
    const record = await ops.transcripts.getThread(threadId);
    const subject = (record?.data as { subject?: unknown } | undefined)?.subject;
    return typeof subject === "string" ? subject : undefined;
  };

  /** The half of `get` that runs once the row is in hand, so the read and the
   *  prefetched read decide identically. */
  const resolve = async (
    threadId: string,
    harnessName: string,
    subject: string,
    row: unknown,
  ): Promise<string | undefined> => {
    const stored = decode(row);
    if (stored === undefined) return undefined;
    if (stored.harness === harnessName) return typeof stored.value === "string" ? stored.value : undefined;
    // §1.3's clearing rule: a different thinker holds this conversation now.
    await ops.harness.clear(threadId, subject);
    return undefined;
  };

  return {
    async get(threadId, harnessName, owner) {
      const subject = owner ?? await ownerOf(threadId);
      // No thread, no slot — the SQL half's missing row, reached differently.
      if (subject === undefined) return undefined;
      return await resolve(threadId, harnessName, subject, await ops.harness.get(threadId, subject));
    },

    async resume(threadId, harnessName, stored, owner) {
      const subject = owner ?? await ownerOf(threadId);
      if (subject === undefined) return undefined;
      return await resolve(threadId, harnessName, subject, stored);
    },

    async set(threadId, harnessName, value, owner) {
      const subject = owner ?? await ownerOf(threadId);
      if (value === undefined) {
        if (subject !== undefined) await ops.harness.clear(threadId, subject);
        return;
      }
      if (subject === undefined) {
        throw new VendoError("not-found", `No thread ${threadId} to hold harness state for.`);
      }
      // One slot per thread, so a harness swap overwrites in place.
      await ops.harness.set(threadId, subject, harnessStateRow(harnessName, value));
    },

    async clear(threadId, owner) {
      const subject = owner ?? await ownerOf(threadId);
      // A thread that is already gone took its slot with it — the slot is a
      // column on that row — so there is nothing to drop.
      if (subject === undefined) return;
      await ops.harness.clear(threadId, subject);
    },
  };
}

/**
 * The SQL half reads and writes ONE column on the thread row, so it needs no
 * `owner` at all: the row carries its own subject, and there is no second key
 * for a caller to get wrong. (`owner` stays in the signature because the ops
 * half genuinely saves a round trip with it.)
 *
 * None of these writes touch `updated_at` or `revision`. Resuming a session is
 * not a message and not an edit: bumping `updated_at` would reshuffle a user's
 * thread list every turn, and bumping `revision` would break the compare-and-swap
 * of any caller holding one.
 */
function overSql(db: Db): HarnessStateStore {
  const drop = async (threadId: string): Promise<void> => {
    await db.query("UPDATE vendo_threads SET harness_state = NULL WHERE id = $1", [threadId]);
  };

  const resolve = async (threadId: string, harnessName: string, row: unknown): Promise<string | undefined> => {
    const stored = decode(row);
    if (stored === undefined) return undefined;
    if (stored.harness === harnessName) return typeof stored.value === "string" ? stored.value : undefined;
    // §1.3's clearing rule: a different thinker holds this conversation now.
    await drop(threadId);
    return undefined;
  };

  return {
    async get(threadId, harnessName) {
      const result = await db.query("SELECT harness_state FROM vendo_threads WHERE id = $1", [threadId]);
      return await resolve(threadId, harnessName, result.rows[0]?.["harness_state"]);
    },

    /** A SQL store is one hop from its own rows, so nothing here batches — but
     *  the verb answers the same question the same way, since the shape is the
     *  contract (a caller must not have to know which backend it holds). */
    resume: (threadId, harnessName, stored) => resolve(threadId, harnessName, stored),

    async set(threadId, harnessName, value) {
      if (value === undefined) {
        await drop(threadId);
        return;
      }
      // The missing-thread refusal is the UPDATE's own answer: no row matched,
      // so there was no conversation to bookmark.
      const result = await db.query(
        "UPDATE vendo_threads SET harness_state = $2::jsonb WHERE id = $1 RETURNING id",
        [threadId, JSON.stringify(harnessStateRow(harnessName, value))],
      );
      if (result.rows.length === 0) {
        throw new VendoError("not-found", `No thread ${threadId} to hold harness state for.`);
      }
    },

    clear: drop,
  };
}

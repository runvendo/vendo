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
 * **No new table, no SCHEMA_VERSION bump** (the wave-3 coordination promise):
 * the state rides `vendo_state`, whose primary key is already `(app_id,
 * subject)`. `app_id` carries the thread — namespaced so it can never collide
 * with a real `app_` id, and so app deletion (which sweeps `vendo_state` by
 * `app_id`) leaves it alone. `subject` is the thread's OWNER, read from
 * `vendo_threads`, which is what puts the row inside the erase cascade
 * (`erase.ts` deletes `vendo_state WHERE subject = $1`) and the anon→signed-in
 * adoption path (`helpers/subjects.ts`) for free.
 *
 * ONE slot per thread carrying its owner's name, exactly as the interface says:
 * a foreign harness DESTROYS the row rather than shadowing it, so swapping back
 * cannot resurrect a session the conversation has outgrown.
 *
 * Typed structurally rather than against `HarnessStateStore` because the store
 * sits BELOW `@vendoai/harnesses` in the layering (contract §2) — the shape is
 * the contract, as it is for `threadMessageStore`.
 */
/** The synthetic `app_id` a thread's harness state rides under. Shared with the
 *  thread delete path (`helpers/threads.ts`), which sweeps the row so no
 *  native-session ref outlives its thread — and with the wire's own harness
 *  family, whose slot is keyed identically so `deleteThread` cascades there too. */
export const harnessStateKey = (threadId: string): string => `harness_state:${threadId}`;

export interface HarnessStateStore {
  get(threadId: string, harnessName: string): Promise<string | undefined>;
  set(threadId: string, harnessName: string, value: string | undefined): Promise<void>;
  clear(threadId: string): Promise<void>;
}

/** The one row's payload, whichever backend holds it. */
interface StoredState {
  harness?: unknown;
  value?: unknown;
}

/** Rows come back as jsonb (an object) or as text, depending on the driver. */
function decode(row: unknown): StoredState | undefined {
  const stored = typeof row === "string" ? (JSON.parse(row) as unknown) : row;
  if (typeof stored !== "object" || stored === null) return undefined;
  return stored as StoredState;
}

export function harnessStateStore(store: VendoStore): HarnessStateStore {
  const backend = backendOf(store, "durable harness state (build contract §1.3)");
  return backend.kind === "ops" ? overOps(backend.ops) : overSql(backend.db);
}

/**
 * The hosted half: the SAME slot — `harness_state:<threadId>` as the appId, the
 * thread's owner as the subject — served by the wire's `harness` family, so a
 * deployment can move between backends without its sessions changing shape.
 *
 * The owner comes from `transcripts.getThread` where SQL reads `vendo_threads`
 * directly. That read is not decoration: the wire's harness verbs are keyed by
 * (appId, subject), and a row stored under the wrong subject is a row no erase
 * and no adoption can reach — the same reason the SQL half refuses to store one.
 */
function overOps(ops: StoreOps): HarnessStateStore {
  const ownerOf = async (threadId: string): Promise<string | undefined> => {
    const record = await ops.transcripts.getThread(threadId);
    const subject = (record?.data as { subject?: unknown } | undefined)?.subject;
    return typeof subject === "string" ? subject : undefined;
  };

  return {
    async get(threadId, harnessName) {
      const subject = await ownerOf(threadId);
      // No thread, no slot — the SQL half's missing row, reached differently.
      if (subject === undefined) return undefined;
      const stored = decode(await ops.harness.get(harnessStateKey(threadId), subject));
      if (stored === undefined) return undefined;
      if (stored.harness === harnessName) return typeof stored.value === "string" ? stored.value : undefined;
      // §1.3's clearing rule: a different thinker holds this conversation now.
      await ops.harness.clear(harnessStateKey(threadId), subject);
      return undefined;
    },

    async set(threadId, harnessName, value) {
      const subject = await ownerOf(threadId);
      if (value === undefined) {
        if (subject !== undefined) await ops.harness.clear(harnessStateKey(threadId), subject);
        return;
      }
      if (subject === undefined) {
        throw new VendoError("not-found", `No thread ${threadId} to hold harness state for.`);
      }
      // One row per (appId, subject), so a harness swap overwrites in place —
      // the SQL half's delete-then-insert, expressed as the wire's own upsert.
      await ops.harness.set(harnessStateKey(threadId), subject, { harness: harnessName, value });
    },

    async clear(threadId) {
      const subject = await ownerOf(threadId);
      // A thread that is already gone took its slot with it (deleteThread
      // cascades the `harness_state:<id>` appId), so there is nothing to drop.
      if (subject === undefined) return;
      await ops.harness.clear(harnessStateKey(threadId), subject);
    },
  };
}

function overSql(db: Db): HarnessStateStore {
  const key = harnessStateKey;

  const ownerOf = async (threadId: string): Promise<string> => {
    const result = await db.query("SELECT subject FROM vendo_threads WHERE id = $1", [threadId]);
    const subject = result.rows[0]?.["subject"];
    if (typeof subject !== "string") {
      // Storing it anyway would leave a row no erase and no adoption can reach,
      // because both cascade on `subject`.
      throw new VendoError("not-found", `No thread ${threadId} to hold harness state for.`);
    }
    return subject;
  };

  const drop = async (threadId: string): Promise<void> => {
    await db.query("DELETE FROM vendo_state WHERE app_id = $1", [key(threadId)]);
  };

  return {
    async get(threadId, harnessName) {
      const result = await db.query("SELECT data FROM vendo_state WHERE app_id = $1", [key(threadId)]);
      const stored = decode(result.rows[0]?.["data"]);
      if (stored === undefined) return undefined;
      if (stored.harness === harnessName) return typeof stored.value === "string" ? stored.value : undefined;
      // §1.3's clearing rule: a different thinker holds this conversation now.
      await drop(threadId);
      return undefined;
    },

    async set(threadId, harnessName, value) {
      if (value === undefined) {
        await drop(threadId);
        return;
      }
      const subject = await ownerOf(threadId);
      const now = new Date().toISOString();
      // The slot is one row per THREAD, so a harness swap overwrites rather than
      // adding a second owner's copy beside the first.
      await drop(threadId);
      await db.query(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [key(threadId), subject, JSON.stringify({ harness: harnessName, value }), now],
      );
    },

    clear: drop,
  };
}

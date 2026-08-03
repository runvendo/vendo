import { VendoError } from "@vendoai/core";
import { dbFor, type VendoStore } from "./store.js";

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
 *  native-session ref outlives its thread. */
export const harnessStateKey = (threadId: string): string => `harness_state:${threadId}`;

export function harnessStateStore(store: VendoStore): {
  get(threadId: string, harnessName: string): Promise<string | undefined>;
  set(threadId: string, harnessName: string, value: string | undefined): Promise<void>;
  clear(threadId: string): Promise<void>;
} {
  const db = dbFor(store);
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
      const row = result.rows[0]?.["data"];
      const stored = typeof row === "string" ? (JSON.parse(row) as unknown) : row;
      if (typeof stored !== "object" || stored === null) return undefined;
      const { harness, value } = stored as { harness?: unknown; value?: unknown };
      if (harness === harnessName) return typeof value === "string" ? value : undefined;
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

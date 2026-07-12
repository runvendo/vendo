import type { Json, Principal, ThreadId } from "@vendoai/core";
import { overlayFor, registerEphemeralSubject } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import type { ThreadRow } from "./types.js";
import { putThreadRow, threadFromRow } from "./rows.js";
import { iso, text } from "./utils.js";
import { parseThreadData } from "../validate.js";

/** 02-store §3 */
export function threadStore(store: VendoStore): {
  put(principal: Principal, thread: { id: ThreadId; messages: Json[] }): Promise<ThreadRow>;
  get(principal: Principal, id: ThreadId): Promise<ThreadRow | null>;
  list(principal: Principal): Promise<Array<{ id: ThreadId; createdAt: string; updatedAt: string }>>;
  delete(principal: Principal, id: ThreadId): Promise<void>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async put(principal, thread) {
      const parsed = parseThreadData({ subject: principal.subject, messages: thread.messages }, thread.id);
      const now = new Date().toISOString();
      if (principal.ephemeral === true) {
        registerEphemeralSubject(store, principal.subject);
        const prior = overlay.threads.get(thread.id);
        const row: ThreadRow = {
          id: thread.id,
          subject: parsed.subject,
          messages: parsed.messages,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        overlay.threads.set(thread.id, row);
        return row;
      }
      return putThreadRow(db, {
        id: thread.id,
        subject: parsed.subject,
        messages: parsed.messages,
      }, now);
    },
    async get(principal, id) {
      if (principal.ephemeral === true) {
        const row = overlay.threads.get(id);
        return row?.subject === principal.subject ? row : null;
      }
      const result = await db.query(
        `SELECT id, subject, messages, created_at, updated_at FROM vendo_threads
         WHERE id = $1 AND subject = $2`,
        [id, principal.subject],
      );
      return result.rows[0] ? threadFromRow(result.rows[0]) : null;
    },
    async list(principal) {
      if (principal.ephemeral === true) {
        return [...overlay.threads.values()]
          .filter((row) => row.subject === principal.subject)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .map(({ id, createdAt, updatedAt }) => ({ id, createdAt, updatedAt }));
      }
      const result = await db.query(
        `SELECT id, created_at, updated_at FROM vendo_threads WHERE subject = $1
         ORDER BY updated_at DESC, id DESC`,
        [principal.subject],
      );
      return result.rows.map((row) => ({
        id: text(row["id"]),
        createdAt: iso(row["created_at"]),
        updatedAt: iso(row["updated_at"]),
      }));
    },
    async delete(principal, id) {
      if (principal.ephemeral === true) {
        const row = overlay.threads.get(id);
        if (row?.subject === principal.subject) overlay.threads.delete(id);
        return;
      }
      await db.query("DELETE FROM vendo_threads WHERE id = $1 AND subject = $2", [id, principal.subject]);
    },
  };
}

export type { ThreadRow } from "./types.js";

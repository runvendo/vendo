import type { Json, Principal, ThreadId } from "@vendoai/core";
import { overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import type { ThreadRow } from "./types.js";
import { iso, text } from "./utils.js";

function fromRow(row: Record<string, unknown>): ThreadRow {
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    messages: row["messages"] as Json[],
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

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
      const now = new Date().toISOString();
      if (principal.ephemeral === true) {
        const prior = overlay.threads.get(thread.id);
        const row: ThreadRow = {
          id: thread.id,
          subject: principal.subject,
          messages: thread.messages,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        overlay.threads.set(thread.id, row);
        return row;
      }
      const result = await db.query(
        `INSERT INTO vendo_threads (id, subject, messages, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $4)
         ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, messages = EXCLUDED.messages,
           updated_at = EXCLUDED.updated_at
         RETURNING id, subject, messages, created_at, updated_at`,
        [thread.id, principal.subject, JSON.stringify(thread.messages), now],
      );
      return fromRow(result.rows[0] as Record<string, unknown>);
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
      return result.rows[0] ? fromRow(result.rows[0]) : null;
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

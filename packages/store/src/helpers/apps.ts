import type { AppDocument, AppId, Principal } from "@vendoai/core";
import { overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import { iso, text } from "./utils.js";
import type { AppRow } from "./types.js";
import { VendoError } from "@vendoai/core";

function fromRow(row: Record<string, unknown>): AppRow {
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    enabled: row["enabled"] === true,
    doc: row["doc"] as AppDocument,
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

/** 02-store §3 */
export function appStore(store: VendoStore): {
  put(principal: Principal, doc: AppDocument, opts?: { enabled?: boolean }): Promise<AppRow>;
  get(id: AppId): Promise<AppRow | null>;
  list(principal: Principal): Promise<AppRow[]>;
  setEnabled(id: AppId, enabled: boolean): Promise<void>;
  delete(id: AppId): Promise<void>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async put(principal, doc, opts = {}) {
      const now = new Date().toISOString();
      if (principal.ephemeral === true) {
        const prior = overlay.apps.get(doc.id);
        const row: AppRow = {
          id: doc.id,
          subject: principal.subject,
          enabled: opts.enabled ?? prior?.enabled ?? true,
          doc,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        overlay.apps.set(doc.id, row);
        return row;
      }
      const result = await db.query(
        `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, enabled = EXCLUDED.enabled,
           doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at
         RETURNING id, subject, enabled, doc, created_at, updated_at`,
        [doc.id, principal.subject, opts.enabled ?? true, JSON.stringify(doc), now],
      );
      return fromRow(result.rows[0] as Record<string, unknown>);
    },
    async get(id) {
      const memory = overlay.apps.get(id);
      if (memory) return memory;
      const result = await db.query(
        "SELECT id, subject, enabled, doc, created_at, updated_at FROM vendo_apps WHERE id = $1",
        [id],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async list(principal) {
      if (principal.ephemeral === true) {
        return [...overlay.apps.values()]
          .filter((row) => row.subject === principal.subject)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      }
      const result = await db.query(
        `SELECT id, subject, enabled, doc, created_at, updated_at FROM vendo_apps
         WHERE subject = $1 ORDER BY created_at ASC, id ASC`,
        [principal.subject],
      );
      return result.rows.map(fromRow);
    },
    async setEnabled(id, enabled) {
      const memory = overlay.apps.get(id);
      if (memory) {
        overlay.apps.set(id, { ...memory, enabled, updatedAt: new Date().toISOString() });
        return;
      }
      const result = await db.query(
        "UPDATE vendo_apps SET enabled = $2, updated_at = $3 WHERE id = $1 RETURNING id",
        [id, enabled, new Date().toISOString()],
      );
      if (result.rows.length === 0) throw new VendoError("not-found", `App ${id} was not found`);
    },
    async delete(id) {
      if (overlay.apps.delete(id)) {
        for (const [key, row] of overlay.states) {
          if (row.appId === id) overlay.states.delete(key);
        }
        return;
      }
      await db.query("DELETE FROM vendo_state WHERE app_id = $1", [id]);
      await db.query("DELETE FROM vendo_apps WHERE id = $1", [id]);
    },
  };
}

export type { AppRow } from "./types.js";

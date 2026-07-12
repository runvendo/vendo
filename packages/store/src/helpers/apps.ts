import type { AppDocument, AppId, Principal } from "@vendoai/core";
import { overlayFor, registerEphemeralSubject, snapshot } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import type { AppRow } from "./types.js";
import { VendoError } from "@vendoai/core";
import { appFromRow, putAppRow } from "./rows.js";
import { parseAppDocument } from "../validate.js";

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
      const parsedDoc = parseAppDocument(doc);
      const now = new Date().toISOString();
      if (principal.ephemeral === true) {
        registerEphemeralSubject(store, principal.subject);
        const prior = overlay.apps.get(parsedDoc.id);
        const row: AppRow = {
          id: parsedDoc.id,
          subject: principal.subject,
          enabled: opts.enabled ?? prior?.enabled ?? true,
          doc: parsedDoc,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        overlay.apps.set(parsedDoc.id, snapshot(row));
        return snapshot(row);
      }
      return putAppRow(db, {
        id: parsedDoc.id,
        subject: principal.subject,
        enabled: opts.enabled ?? true,
        doc: parsedDoc,
      }, now);
    },
    async get(id) {
      const memory = overlay.apps.get(id);
      if (memory) return snapshot(memory);
      const result = await db.query(
        "SELECT id, subject, enabled, doc, created_at, updated_at FROM vendo_apps WHERE id = $1",
        [id],
      );
      return result.rows[0] ? appFromRow(result.rows[0]) : null;
    },
    async list(principal) {
      if (principal.ephemeral === true) {
        return [...overlay.apps.values()]
          .filter((row) => row.subject === principal.subject)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map(snapshot);
      }
      const result = await db.query(
        `SELECT id, subject, enabled, doc, created_at, updated_at FROM vendo_apps
         WHERE subject = $1 ORDER BY created_at ASC, id ASC`,
        [principal.subject],
      );
      return result.rows.map(appFromRow);
    },
    async setEnabled(id, enabled) {
      const memory = overlay.apps.get(id);
      if (memory) {
        overlay.apps.set(id, snapshot({ ...memory, enabled, updatedAt: new Date().toISOString() }));
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

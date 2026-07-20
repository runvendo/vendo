import type { AppDocument, AppId, Principal } from "@vendoai/core";
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
  return {
    async put(principal, doc, opts = {}) {
      const parsedDoc = parseAppDocument(doc);
      // Apps never cross subjects (02 §2): the guarded upsert refuses a
      // foreign-owned id atomically.
      return putAppRow(db, {
        id: parsedDoc.id,
        subject: principal.subject,
        enabled: opts.enabled ?? true,
        doc: parsedDoc,
      });
    },
    async get(id) {
      const result = await db.query(
        "SELECT id, subject, enabled, doc, created_at, updated_at, revision FROM vendo_apps WHERE id = $1",
        [id],
      );
      return result.rows[0] ? appFromRow(result.rows[0]) : null;
    },
    async list(principal) {
      const result = await db.query(
        `SELECT id, subject, enabled, doc, created_at, updated_at, revision FROM vendo_apps
         WHERE subject = $1 ORDER BY created_at ASC, id ASC`,
        [principal.subject],
      );
      return result.rows.map(appFromRow);
    },
    async setEnabled(id, enabled) {
      // Wave 7 — every vendo_apps write door bumps the token: a CAS armed with
      // a pre-flip revision must lose, or it would silently revert this flip.
      const result = await db.query(
        "UPDATE vendo_apps SET enabled = $2, updated_at = $3, revision = revision + 1 WHERE id = $1 RETURNING id",
        [id, enabled, new Date().toISOString()],
      );
      if (result.rows.length === 0) throw new VendoError("not-found", `App ${id} was not found`);
    },
    async delete(id) {
      await db.query("DELETE FROM vendo_state WHERE app_id = $1", [id]);
      await db.query("DELETE FROM vendo_apps WHERE id = $1", [id]);
    },
  };
}

export type { AppRow } from "./types.js";

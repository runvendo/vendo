import {
  type AppDocument,
  type AppId,
  type Principal,
  VendoError,
} from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import type { AppRow } from "./types.js";
import { appFromRow, putAppRow } from "./rows.js";
import { parseAppDocument } from "../validate.js";

/** 02-store §3 */
export function appStore(store: VendoStore): {
  put(principal: Principal, doc: AppDocument, opts?: { enabled?: boolean }): Promise<AppRow>;
  get(id: AppId): Promise<AppRow | null>;
  list(principal: Principal): Promise<AppRow[]>;
  setEnabled(id: AppId, enabled: boolean): Promise<void>;
  delete(id: AppId): Promise<void>;
  /** Build contract §9.5 — the SECOND sanctioned door through 02-store §2's
      "rows never cross subjects" (the first is anon→signed-in adoption): a
      promote moves the canonical app into an org, and the org id becomes the
      row subject verbatim. Guarded on the CURRENT subject, so a promote can
      only ever move a row its caller was proven to own. */
  promote(id: AppId, from: string, orgId: string): Promise<void>;
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
    async promote(id, from, orgId) {
      // Wave 7's rule holds here too: every vendo_apps write door bumps the
      // token, or a CAS armed before the promote would revert the move.
      const result = await db.query(
        `UPDATE vendo_apps SET subject = $3, updated_at = $4, revision = revision + 1
         WHERE id = $1 AND subject = $2 RETURNING id`,
        [id, from, orgId, new Date().toISOString()],
      );
      if (result.rows.length === 0) {
        throw new VendoError("conflict", `app ${id} belongs to another subject`);
      }
      // Per-user app data (vendo_state, the app's record collections) is keyed
      // by app id and stays subject-partitioned, so it needs nothing: the org
      // now owns the app, and each member still sees only their own rows.
    },
  };
}

export type { AppRow } from "./types.js";

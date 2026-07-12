import type { AppId, Json, Principal } from "@vendoai/core";
import { overlayFor, registerEphemeralSubject, snapshot, stateKey } from "../ephemeral.js";
import { putStateRow } from "./rows.js";
import { dbFor, type VendoStore } from "../store.js";
import { requireJson } from "../validate.js";

/** 02-store §3 */
export function stateStore(store: VendoStore): {
  get(principal: Principal, appId: AppId): Promise<Json | null>;
  put(principal: Principal, appId: AppId, data: Json): Promise<void>;
  delete(principal: Principal, appId: AppId): Promise<void>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async get(principal, appId) {
      if (principal.ephemeral === true) {
        registerEphemeralSubject(store, principal.subject);
        const row = overlay.states.get(stateKey(principal.subject, appId));
        return row ? snapshot(row.data) : null;
      }
      const result = await db.query(
        "SELECT data FROM vendo_state WHERE app_id = $1 AND subject = $2",
        [appId, principal.subject],
      );
      return result.rows[0]?.["data"] ?? null;
    },
    async put(principal, appId, data) {
      const parsedData = requireJson(data, "state data");
      const now = new Date().toISOString();
      if (principal.ephemeral === true) {
        // Register the subject BEFORE the write (02 §4): otherwise a later seam
        // write for the same ephemeral subject would decide "not ephemeral" and
        // INSERT this data durably into vendo_state — a disk leak + read split-brain.
        registerEphemeralSubject(store, principal.subject);
        const key = stateKey(principal.subject, appId);
        const prior = overlay.states.get(key);
        overlay.states.set(
          key,
          snapshot({
            appId,
            subject: principal.subject,
            data: parsedData,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          }),
        );
        return;
      }
      // Shared write path with the routed seam (helpers/rows putStateRow).
      await putStateRow(db, { appId, subject: principal.subject, data: parsedData }, now);
    },
    async delete(principal, appId) {
      if (principal.ephemeral === true) {
        registerEphemeralSubject(store, principal.subject);
        overlay.states.delete(stateKey(principal.subject, appId));
        return;
      }
      await db.query("DELETE FROM vendo_state WHERE app_id = $1 AND subject = $2", [appId, principal.subject]);
    },
  };
}

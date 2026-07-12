import type { AppId, Json, Principal } from "@vendoai/core";
import { overlayFor, stateKey } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";

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
        return overlay.states.get(stateKey(principal.subject, appId))?.data ?? null;
      }
      const result = await db.query(
        "SELECT data FROM vendo_state WHERE app_id = $1 AND subject = $2",
        [appId, principal.subject],
      );
      return result.rows[0]?.["data"] ?? null;
    },
    async put(principal, appId, data) {
      if (principal.ephemeral === true) {
        overlay.states.set(stateKey(principal.subject, appId), { appId, subject: principal.subject, data });
        return;
      }
      await db.query(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (app_id, subject) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [appId, principal.subject, JSON.stringify(data), new Date().toISOString()],
      );
    },
    async delete(principal, appId) {
      if (principal.ephemeral === true) {
        overlay.states.delete(stateKey(principal.subject, appId));
        return;
      }
      await db.query("DELETE FROM vendo_state WHERE app_id = $1 AND subject = $2", [appId, principal.subject]);
    },
  };
}

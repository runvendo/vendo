import type { AppId, Json, Principal } from "@vendoai/core";
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
  return {
    async get(principal, appId) {
      const result = await db.query(
        "SELECT data FROM vendo_state WHERE app_id = $1 AND subject = $2",
        [appId, principal.subject],
      );
      return result.rows[0]?.["data"] ?? null;
    },
    async put(principal, appId, data) {
      const parsedData = requireJson(data, "state data");
      // Shared write path with the routed seam (helpers/rows putStateRow).
      await putStateRow(db, { appId, subject: principal.subject, data: parsedData });
    },
    async delete(principal, appId) {
      await db.query("DELETE FROM vendo_state WHERE app_id = $1 AND subject = $2", [appId, principal.subject]);
    },
  };
}

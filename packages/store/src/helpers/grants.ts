import {
  VendoError,
  type AppId,
  type GrantId,
  type IsoDateTime,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";
import { overlayFor, registerEphemeralSubject } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import { grantFromRow, putGrantRow } from "./rows.js";
import { parsePermissionGrant } from "../validate.js";

function active(grant: PermissionGrant, now: string): boolean {
  return grant.revokedAt === undefined && (grant.expiresAt === undefined || grant.expiresAt > now);
}

/** 02-store §3 */
export function grantStore(store: VendoStore): {
  create(principal: Principal, grant: PermissionGrant): Promise<void>;
  get(id: GrantId): Promise<PermissionGrant | null>;
  list(principal: Principal, filter?: { tool?: string; appId?: AppId; includeInactive?: boolean }): Promise<PermissionGrant[]>;
  revoke(id: GrantId, revokedAt: IsoDateTime): Promise<void>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async create(principal, grant) {
      const parsedGrant = parsePermissionGrant(grant);
      if (parsedGrant.subject !== principal.subject) {
        throw new VendoError("validation", "Grant subject must match principal subject");
      }
      if (principal.ephemeral === true) {
        registerEphemeralSubject(store, principal.subject);
        overlay.grants.set(parsedGrant.id, parsedGrant);
        return;
      }
      await putGrantRow(db, parsedGrant, false);
    },
    async get(id) {
      const memory = overlay.grants.get(id);
      if (memory) return memory;
      const result = await db.query("SELECT * FROM vendo_grants WHERE id = $1", [id]);
      return result.rows[0] ? grantFromRow(result.rows[0]) : null;
    },
    async list(principal, filter = {}) {
      if (principal.ephemeral === true) {
        const now = new Date().toISOString();
        return [...overlay.grants.values()]
          .filter((grant) => grant.subject === principal.subject)
          .filter((grant) => filter.tool === undefined || grant.tool === filter.tool)
          .filter((grant) => filter.appId === undefined || grant.appId === filter.appId)
          .filter((grant) => filter.includeInactive === true || active(grant, now))
          .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
      }
      const params: unknown[] = [principal.subject];
      const clauses = ["subject = $1"];
      if (filter.tool !== undefined) {
        params.push(filter.tool);
        clauses.push(`tool = $${params.length}`);
      }
      if (filter.appId !== undefined) {
        params.push(filter.appId);
        clauses.push(`app_id = $${params.length}`);
      }
      if (filter.includeInactive !== true) {
        clauses.push("revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
      }
      const result = await db.query(
        `SELECT * FROM vendo_grants WHERE ${clauses.join(" AND ")} ORDER BY granted_at ASC, id ASC`,
        params,
      );
      return result.rows.map(grantFromRow);
    },
    async revoke(id, revokedAt) {
      const memory = overlay.grants.get(id);
      if (memory) {
        overlay.grants.set(id, { ...memory, revokedAt });
        return;
      }
      const result = await db.query(
        "UPDATE vendo_grants SET revoked_at = $2 WHERE id = $1 RETURNING id",
        [id, revokedAt],
      );
      if (result.rows.length === 0) throw new VendoError("not-found", `Grant ${id} was not found`);
    },
  };
}

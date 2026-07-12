import {
  VendoError,
  type AppId,
  type GrantId,
  type IsoDateTime,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";
import { overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import { iso, optionalIso, text } from "./utils.js";

function fromRow(row: Record<string, unknown>): PermissionGrant {
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    tool: text(row["tool"]),
    descriptorHash: text(row["descriptor_hash"]),
    scope: row["scope"] as PermissionGrant["scope"],
    duration: text(row["duration"]) as PermissionGrant["duration"],
    ...(row["context_key"] == null ? {} : { contextKey: text(row["context_key"]) }),
    ...(row["app_id"] == null ? {} : { appId: text(row["app_id"]) }),
    source: text(row["source"]) as PermissionGrant["source"],
    grantedAt: iso(row["granted_at"]),
    ...(optionalIso(row["expires_at"]) ? { expiresAt: optionalIso(row["expires_at"]) } : {}),
    ...(optionalIso(row["revoked_at"]) ? { revokedAt: optionalIso(row["revoked_at"]) } : {}),
  };
}

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
      if (grant.subject !== principal.subject) {
        throw new VendoError("validation", "Grant subject must match principal subject");
      }
      if (principal.ephemeral === true) {
        overlay.grants.set(grant.id, grant);
        return;
      }
      await db.query(
        `INSERT INTO vendo_grants
         (id, subject, tool, descriptor_hash, scope, duration, context_key, app_id, source, granted_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
        [grant.id, grant.subject, grant.tool, grant.descriptorHash, JSON.stringify(grant.scope), grant.duration,
          grant.contextKey ?? null, grant.appId ?? null, grant.source, grant.grantedAt,
          grant.expiresAt ?? null, grant.revokedAt ?? null],
      );
    },
    async get(id) {
      const memory = overlay.grants.get(id);
      if (memory) return memory;
      const result = await db.query("SELECT * FROM vendo_grants WHERE id = $1", [id]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
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
      return result.rows.map(fromRow);
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

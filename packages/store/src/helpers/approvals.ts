import type { ApprovalId, ApprovalRequest, IsoDateTime, Principal } from "@vendoai/core";
import { overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import type { ApprovalRow } from "./types.js";
import { iso, optionalIso, text } from "./utils.js";

function fromRow(row: Record<string, unknown>): ApprovalRow {
  const decidedAt = optionalIso(row["decided_at"]);
  return {
    id: text(row["id"]),
    subject: text(row["subject"]),
    request: row["request"] as ApprovalRequest,
    status: text(row["status"]) as ApprovalRow["status"],
    ...(decidedAt === undefined ? {} : { decidedAt }),
    createdAt: iso(row["created_at"]),
  };
}

/** 02-store §3 */
export function approvalStore(store: VendoStore): {
  create(request: ApprovalRequest): Promise<void>;
  get(id: ApprovalId): Promise<ApprovalRow | null>;
  pending(principal: Principal): Promise<ApprovalRequest[]>;
  decide(ids: ApprovalId | ApprovalId[], status: "approved" | "denied", decidedAt: IsoDateTime): Promise<ApprovalId[]>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async create(request) {
      const subject = request.ctx.principal.subject;
      if (request.ctx.principal.ephemeral === true) {
        overlay.approvals.set(request.id, {
          id: request.id,
          subject,
          request,
          status: "pending",
          createdAt: request.createdAt,
        });
        return;
      }
      await db.query(
        `INSERT INTO vendo_approvals (id, subject, request, status, decided_at, created_at)
         VALUES ($1, $2, $3::jsonb, 'pending', NULL, $4)`,
        [request.id, subject, JSON.stringify(request), request.createdAt],
      );
    },
    async get(id) {
      const memory = overlay.approvals.get(id);
      if (memory) return memory;
      const result = await db.query("SELECT * FROM vendo_approvals WHERE id = $1", [id]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async pending(principal) {
      if (principal.ephemeral === true) {
        return [...overlay.approvals.values()]
          .filter((row) => row.subject === principal.subject && row.status === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map((row) => row.request);
      }
      const result = await db.query(
        `SELECT request FROM vendo_approvals WHERE subject = $1 AND status = 'pending'
         ORDER BY created_at ASC, id ASC`,
        [principal.subject],
      );
      return result.rows.map((row) => row["request"] as ApprovalRequest);
    },
    async decide(ids, status, decidedAt) {
      const requested = [...new Set(Array.isArray(ids) ? ids : [ids])];
      const decided = new Set<ApprovalId>();
      const diskIds: ApprovalId[] = [];
      for (const id of requested) {
        const row = overlay.approvals.get(id);
        if (!row) {
          diskIds.push(id);
          continue;
        }
        if (row.status === "pending") {
          overlay.approvals.set(id, { ...row, status, decidedAt });
          decided.add(id);
        }
      }
      if (diskIds.length > 0) {
        const result = await db.query(
          `UPDATE vendo_approvals SET status = $2, decided_at = $3
           WHERE id = ANY($1::text[]) AND status = 'pending' RETURNING id`,
          [diskIds, status, decidedAt],
        );
        for (const row of result.rows) decided.add(text(row["id"]));
      }
      return requested.filter((id) => decided.has(id));
    },
  };
}

export type { ApprovalRow } from "./types.js";

import type { ApprovalId, ApprovalRequest, IsoDateTime, Principal } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import type { ApprovalRow } from "./types.js";
import { approvalFromRow, putApprovalRow } from "./rows.js";
import { text } from "./utils.js";
import { parseApprovalRequest } from "../validate.js";

/** 02-store §3 */
export function approvalStore(store: VendoStore): {
  create(request: ApprovalRequest): Promise<void>;
  get(id: ApprovalId): Promise<ApprovalRow | null>;
  pending(principal: Principal): Promise<ApprovalRequest[]>;
  decide(ids: ApprovalId | ApprovalId[], status: "approved" | "denied", decidedAt: IsoDateTime): Promise<ApprovalId[]>;
} {
  const db = dbFor(store);
  return {
    async create(request) {
      const parsedRequest = parseApprovalRequest(request);
      await putApprovalRow(db, {
        id: parsedRequest.id,
        subject: parsedRequest.ctx.principal.subject,
        request: parsedRequest,
        status: "pending",
        createdAt: parsedRequest.createdAt,
      }, false);
    },
    async get(id) {
      const result = await db.query("SELECT * FROM vendo_approvals WHERE id = $1", [id]);
      return result.rows[0] ? approvalFromRow(result.rows[0]) : null;
    },
    async pending(principal) {
      const result = await db.query(
        `SELECT request FROM vendo_approvals WHERE subject = $1 AND status = 'pending'
         ORDER BY created_at ASC, id ASC`,
        [principal.subject],
      );
      return result.rows.map((row) => row["request"] as ApprovalRequest);
    },
    async decide(ids, status, decidedAt) {
      const requested = [...new Set(Array.isArray(ids) ? ids : [ids])];
      const result = await db.query(
        `UPDATE vendo_approvals SET status = $2, decided_at = $3
         WHERE id = ANY($1::text[]) AND status = 'pending' RETURNING id`,
        [requested, status, decidedAt],
      );
      const decided = new Set(result.rows.map((row) => text(row["id"])));
      return requested.filter((id) => decided.has(id));
    },
  };
}

export type { ApprovalRow } from "./types.js";

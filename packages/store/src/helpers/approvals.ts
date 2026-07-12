import type { ApprovalId, ApprovalRequest, IsoDateTime, Principal } from "@vendoai/core";
import { overlayFor, registerEphemeralSubject, snapshot } from "../ephemeral.js";
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
  const overlay = overlayFor(store);
  return {
    async create(request) {
      const parsedRequest = parseApprovalRequest(request);
      const subject = parsedRequest.ctx.principal.subject;
      if (parsedRequest.ctx.principal.ephemeral === true) {
        registerEphemeralSubject(store, subject);
        overlay.approvals.set(parsedRequest.id, snapshot({
          id: parsedRequest.id,
          subject,
          request: parsedRequest,
          status: "pending",
          createdAt: parsedRequest.createdAt,
        }));
        return;
      }
      await putApprovalRow(db, {
        id: parsedRequest.id,
        subject,
        request: parsedRequest,
        status: "pending",
        createdAt: parsedRequest.createdAt,
      }, false);
    },
    async get(id) {
      const memory = overlay.approvals.get(id);
      if (memory) return snapshot(memory);
      const result = await db.query("SELECT * FROM vendo_approvals WHERE id = $1", [id]);
      return result.rows[0] ? approvalFromRow(result.rows[0]) : null;
    },
    async pending(principal) {
      if (principal.ephemeral === true) {
        return [...overlay.approvals.values()]
          .filter((row) => row.subject === principal.subject && row.status === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map((row) => snapshot(row.request));
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
          overlay.approvals.set(id, snapshot({ ...row, status, decidedAt }));
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

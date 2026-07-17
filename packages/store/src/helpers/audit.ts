import type { AppId, AuditEvent, IsoDateTime, Principal } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import { putAuditRow } from "./rows.js";
import { decodeCursor, encodeCursor, iso, pageLimit, text } from "./utils.js";
import { parseAuditEvent } from "../validate.js";

export interface AuditQuery {
  principal?: Principal;
  appId?: AppId;
  kind?: AuditEvent["kind"];
  from?: IsoDateTime;
  to?: IsoDateTime;
  cursor?: string;
  limit?: number;
}

/** 02-store §3 */
export function auditStore(store: VendoStore): {
  append(event: AuditEvent): Promise<void>;
  query(filter: AuditQuery): Promise<{ events: AuditEvent[]; cursor?: string }>;
  export(filter?: { from?: IsoDateTime; to?: IsoDateTime }): AsyncIterable<string>;
} {
  const db = dbFor(store);
  return {
    async append(event) {
      // putAuditRow refuses to replace an existing row (append-only, 02 §2).
      await putAuditRow(db, parseAuditEvent(event));
    },
    async query(filter) {
      const limit = pageLimit(filter.limit);
      const params: unknown[] = [];
      const clauses: string[] = [];
      const add = (sql: string, value: unknown): void => {
        params.push(value);
        clauses.push(sql.replace("?", `$${params.length}`));
      };
      if (filter.principal) add("subject = ?", filter.principal.subject);
      if (filter.appId !== undefined) add("app_id = ?", filter.appId);
      if (filter.kind !== undefined) add("kind = ?", filter.kind);
      if (filter.from !== undefined) add("at >= ?", filter.from);
      if (filter.to !== undefined) add("at <= ?", filter.to);
      if (filter.cursor !== undefined) {
        const cursor = decodeCursor(filter.cursor);
        params.push(cursor.c, cursor.i);
        clauses.push(`(at, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `SELECT id, at, event FROM vendo_audit${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const events = result.rows.slice(0, limit).map((row) => row["event"] as AuditEvent);
      const lastRow = result.rows[Math.min(limit, result.rows.length) - 1];
      return {
        events,
        ...(result.rows.length > limit && lastRow
          ? { cursor: encodeCursor(iso(lastRow["at"]), text(lastRow["id"])) }
          : {}),
      };
    },
    async *export(filter = {}) {
      let cursor: { c: string; i: string } | undefined;
      while (true) {
        const params: unknown[] = [];
        const clauses: string[] = [];
        if (filter.from !== undefined) {
          params.push(filter.from);
          clauses.push(`at >= $${params.length}`);
        }
        if (filter.to !== undefined) {
          params.push(filter.to);
          clauses.push(`at <= $${params.length}`);
        }
        if (cursor) {
          params.push(cursor.c, cursor.i);
          clauses.push(`(at, id) > ($${params.length - 1}, $${params.length})`);
        }
        params.push(500);
        const result = await db.query(
          `SELECT id, at, event FROM vendo_audit${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY at ASC, id ASC LIMIT $${params.length}`,
          params,
        );
        for (const row of result.rows) yield `${JSON.stringify(row["event"])}\n`;
        const last = result.rows.at(-1);
        if (!last || result.rows.length < 500) return;
        cursor = { c: iso(last["at"]), i: text(last["id"]) };
      }
    },
  };
}

import type { AppId, AuditEvent, IsoDateTime, Principal } from "@vendoai/core";
import { overlayFor, registerEphemeralSubject, snapshot } from "../ephemeral.js";
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

function afterDescendingCursor(event: AuditEvent, cursor: { c: string; i: string }): boolean {
  return event.at < cursor.c || (event.at === cursor.c && event.id < cursor.i);
}

/** 02-store §3 */
export function auditStore(store: VendoStore): {
  append(event: AuditEvent): Promise<void>;
  query(filter: AuditQuery): Promise<{ events: AuditEvent[]; cursor?: string }>;
  export(filter?: { from?: IsoDateTime; to?: IsoDateTime }): AsyncIterable<string>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async append(event) {
      const parsedEvent = parseAuditEvent(event);
      if (parsedEvent.principal.ephemeral === true) {
        registerEphemeralSubject(store, parsedEvent.principal.subject);
        overlay.audit.set(parsedEvent.id, snapshot(parsedEvent));
        return;
      }
      await putAuditRow(db, parsedEvent);
    },
    async query(filter) {
      const limit = pageLimit(filter.limit);
      if (filter.principal?.ephemeral === true) {
        const cursor = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor);
        const matching = [...overlay.audit.values()]
          .filter((event) => event.principal.subject === filter.principal?.subject)
          .filter((event) => filter.appId === undefined || event.appId === filter.appId)
          .filter((event) => filter.kind === undefined || event.kind === filter.kind)
          .filter((event) => filter.from === undefined || event.at >= filter.from)
          .filter((event) => filter.to === undefined || event.at <= filter.to)
          .filter((event) => cursor === undefined || afterDescendingCursor(event, cursor))
          .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
        const events = matching.slice(0, limit).map(snapshot);
        const last = events.at(-1);
        return {
          events,
          ...(matching.length > limit && last ? { cursor: encodeCursor(last.at, last.id) } : {}),
        };
      }

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

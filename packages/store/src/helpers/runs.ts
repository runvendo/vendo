import type { AppId, RunId } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import type { RunRow } from "./types.js";
import { decodeCursor, encodeCursor, iso, optionalIso, pageLimit, text } from "./utils.js";

function fromRow(row: Record<string, unknown>): RunRow {
  const finishedAt = optionalIso(row["finished_at"]);
  return {
    id: text(row["id"]),
    appId: text(row["app_id"]),
    trigger: row["trigger"] as RunRow["trigger"],
    status: text(row["status"]) as RunRow["status"],
    record: row["record"],
    startedAt: iso(row["started_at"]),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

/** 02-store §3 */
export function runStore(store: VendoStore): {
  put(run: RunRow): Promise<void>;
  get(id: RunId): Promise<RunRow | null>;
  list(filter: { appId?: AppId; status?: RunRow["status"]; limit?: number; cursor?: string }): Promise<{ runs: RunRow[]; cursor?: string }>;
} {
  const db = dbFor(store);
  return {
    async put(run) {
      await db.query(
        `INSERT INTO vendo_runs (id, app_id, trigger, status, record, started_at, finished_at)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, trigger = EXCLUDED.trigger,
           status = EXCLUDED.status, record = EXCLUDED.record, started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at`,
        [run.id, run.appId, JSON.stringify(run.trigger), run.status, JSON.stringify(run.record),
          run.startedAt, run.finishedAt ?? null],
      );
    },
    async get(id) {
      const result = await db.query("SELECT * FROM vendo_runs WHERE id = $1", [id]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async list(filter) {
      const limit = pageLimit(filter.limit);
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (filter.appId !== undefined) {
        params.push(filter.appId);
        clauses.push(`app_id = $${params.length}`);
      }
      if (filter.status !== undefined) {
        params.push(filter.status);
        clauses.push(`status = $${params.length}`);
      }
      if (filter.cursor !== undefined) {
        const cursor = decodeCursor(filter.cursor);
        params.push(cursor.c, cursor.i);
        clauses.push(`(started_at, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `SELECT * FROM vendo_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY started_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const runs = result.rows.slice(0, limit).map(fromRow);
      const last = runs.at(-1);
      return {
        runs,
        ...(result.rows.length > limit && last ? { cursor: encodeCursor(last.startedAt, last.id) } : {}),
      };
    },
  };
}

export type { RunRow } from "./types.js";

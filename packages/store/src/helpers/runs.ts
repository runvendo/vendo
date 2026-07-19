import type { AppId, RunId } from "@vendoai/core";
import { dbFor, type VendoStore } from "../store.js";
import type { RunRow } from "./types.js";
import { putRunRow, runFromRow } from "./rows.js";
import { decodeCursor, encodeCursor, pageLimit } from "./utils.js";
import { parseRunData } from "../validate.js";

/** 02-store §3 */
export function runStore(store: VendoStore): {
  put(run: RunRow): Promise<void>;
  get(id: RunId): Promise<RunRow | null>;
  list(filter: { appId?: AppId; status?: RunRow["status"]; limit?: number; cursor?: string }): Promise<{ runs: RunRow[]; cursor?: string }>;
} {
  const db = dbFor(store);
  return {
    async put(run) {
      await putRunRow(db, { id: run.id, ...parseRunData(run, run.id) });
    },
    async get(id) {
      const result = await db.query("SELECT * FROM vendo_runs WHERE id = $1", [id]);
      return result.rows[0] ? runFromRow(result.rows[0]) : null;
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
      const runs = result.rows.slice(0, limit).map(runFromRow);
      const last = runs.at(-1);
      return {
        runs,
        ...(result.rows.length > limit && last
          ? { cursor: encodeCursor(last.startedAt, last.id) }
          : {}),
      };
    },
  };
}

export type { RunRow } from "./types.js";

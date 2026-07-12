import type { AppId, RunId } from "@vendoai/core";
import { isEphemeralApp, overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";
import type { RunRow } from "./types.js";
import { putRunRow, runFromRow } from "./rows.js";
import { decodeCursor, encodeCursor, pageLimit } from "./utils.js";

/** 02-store §3 */
export function runStore(store: VendoStore): {
  put(run: RunRow): Promise<void>;
  get(id: RunId): Promise<RunRow | null>;
  list(filter: { appId?: AppId; status?: RunRow["status"]; limit?: number; cursor?: string }): Promise<{ runs: RunRow[]; cursor?: string }>;
} {
  const db = dbFor(store);
  const overlay = overlayFor(store);
  return {
    async put(run) {
      if (await isEphemeralApp(store, db, run.appId)) {
        overlay.runs.set(run.id, run);
        return;
      }
      await putRunRow(db, run);
    },
    async get(id) {
      const memory = overlay.runs.get(id);
      if (memory) return memory;
      const result = await db.query("SELECT * FROM vendo_runs WHERE id = $1", [id]);
      return result.rows[0] ? runFromRow(result.rows[0]) : null;
    },
    async list(filter) {
      const limit = pageLimit(filter.limit);
      const cursor = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor);
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
        params.push(cursor?.c, cursor?.i);
        clauses.push(`(started_at, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await db.query(
        `SELECT * FROM vendo_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY started_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const memoryIds = new Set(overlay.runs.keys());
      const memoryRuns = [...overlay.runs.values()]
        .filter((run) => filter.appId === undefined || run.appId === filter.appId)
        .filter((run) => filter.status === undefined || run.status === filter.status)
        .filter((run) => cursor === undefined || run.startedAt < cursor.c
          || (run.startedAt === cursor.c && run.id < cursor.i));
      const runs = [
        ...result.rows.map(runFromRow).filter((run) => !memoryIds.has(run.id)),
        ...memoryRuns,
      ].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, limit);
      const last = runs.at(-1);
      return {
        runs,
        ...((result.rows.length > limit || memoryRuns.length + result.rows.length > limit) && last
          ? { cursor: encodeCursor(last.startedAt, last.id) }
          : {}),
      };
    },
  };
}

export type { RunRow } from "./types.js";

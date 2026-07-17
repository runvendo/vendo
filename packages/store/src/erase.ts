import { dbFor, type VendoStore } from "./store.js";
import { invalid } from "./validate.js";

/** 02-store §5 — every table in §2's public map. The erase API cascades the
 *  matching data across all of them; `vendo_meta` holds schema metadata (schema
 *  version, boot id), never user data, so no selector ever matches it and its
 *  count stays 0 — as does `vendo_secrets` (name-keyed host config, likewise
 *  never matched by a subject or app selector). Listed so the report provably
 *  covers the whole map. */
export const ERASE_TABLES = [
  "vendo_meta",
  "vendo_apps",
  "vendo_records",
  "vendo_blobs",
  "vendo_state",
  "vendo_threads",
  "vendo_grants",
  "vendo_approvals",
  "vendo_audit",
  "vendo_runs",
  "vendo_secrets",
  "vendo_mcp_clients",
  "vendo_mcp_grants",
  "vendo_sessions",
] as const;

export type EraseTable = typeof ERASE_TABLES[number];

/** Rows deleted per table. */
export type EraseReport = Record<EraseTable, number>;

function emptyReport(): EraseReport {
  return Object.fromEntries(ERASE_TABLES.map((table) => [table, 0])) as EraseReport;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * 02-store §5 — the store-level erase API: by subject (full erasure) or by
 * app, cascading the matching data across all 14 tables of §2's map. It is
 * the ONLY sanctioned deletion path for `vendo_audit` rows — the routed door
 * refuses audit deletion (§2); this API reaches the tables directly.
 * Ephemeral subjects are erased the same way (their rows are ordinary disk
 * rows — kill-list B3); the TTL sweep (sessions.ts) is built on this cascade.
 * Policy engines and schedulers stay out of scope: hosts call this from their
 * own jobs, and host SQL remains available for everything else.
 */
export function eraseStore(store: VendoStore): {
  /** Full erasure of one subject: their apps (and each app's records, blobs,
      state, and runs), plus every subject-keyed or subject-ref'd row and the
      subject's session registration (§4). */
  bySubject(subject: string): Promise<EraseReport>;
  /** Erase one app: its row, record collections, blob namespaces, state, runs,
      app-scoped grants and audit rows, and app-ref'd generic/door rows.
      (Threads and approvals have no app axis in §2 — the subject selector
      covers them.) */
  byApp(appId: string): Promise<EraseReport>;
} {
  const db = dbFor(store);

  const del = async (
    report: EraseReport,
    table: EraseTable,
    where: string,
    params: unknown[],
  ): Promise<void> => {
    const result = await db.query(`DELETE FROM ${table} WHERE ${where} RETURNING 1`, params);
    report[table] += result.rows.length;
  };

  /** App-scoped data shared by the subject and app cascades: the app's record
      collections and blob namespaces (`app:<appId>:...` — §3's naming
      convention), its per-user state, and its run records. */
  const eraseAppData = async (report: EraseReport, appId: string): Promise<void> => {
    const prefix = `app:${escapeLike(appId)}:%`;
    await del(report, "vendo_records", "collection LIKE $1 ESCAPE '\\'", [prefix]);
    await del(report, "vendo_blobs", "namespace LIKE $1 ESCAPE '\\'", [prefix]);
    await del(report, "vendo_state", "app_id = $1", [appId]);
    await del(report, "vendo_runs", "app_id = $1", [appId]);
  };

  return {
    async bySubject(subject) {
      if (typeof subject !== "string" || subject === "") {
        invalid("erase subject must be a non-empty string");
      }
      const report = emptyReport();
      const subjectRef = JSON.stringify({ subject });

      // The subject's apps drive the app-scoped cascade (records/blobs/state/runs
      // carry the app id, not the subject). The app ROWS are deleted FIRST:
      // once they are gone, no new gated write (records/blobs WHERE EXISTS)
      // can land, so the data deletes below collect any stragglers — the
      // remaining race residue is a write statement already in flight.
      const owned = (await db.query("SELECT id FROM vendo_apps WHERE subject = $1", [subject])).rows
        .map((row) => String(row["id"]));
      await del(report, "vendo_apps", "subject = $1", [subject]);
      for (const appId of owned) await eraseAppData(report, appId);

      // Ordering matters for accurate counts: the app cascade above already
      // removed the subject's own state/run rows, so the subject-level deletes
      // below only count rows the cascade did not reach (e.g. this subject's
      // state under ANOTHER owner's app).
      await del(report, "vendo_state", "subject = $1", [subject]);
      await del(report, "vendo_threads", "subject = $1", [subject]);
      await del(report, "vendo_grants", "subject = $1", [subject]);
      await del(report, "vendo_approvals", "subject = $1", [subject]);
      await del(report, "vendo_audit", "subject = $1", [subject]);
      // Generic and door-owned rows carry the subject only as a ref (§2/§3).
      await del(report, "vendo_records", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_mcp_clients", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_mcp_grants", "refs @> $1::jsonb", [subjectRef]);
      // The session registration (if any) is retired with the data (§4).
      await del(report, "vendo_sessions", "subject = $1", [subject]);
      return report;
    },

    async byApp(appId) {
      if (typeof appId !== "string" || appId === "") {
        invalid("erase appId must be a non-empty string");
      }
      const report = emptyReport();
      const appRef = JSON.stringify({ app_id: appId });

      // App row first (same gate-closing order as bySubject), then its data.
      await del(report, "vendo_apps", "id = $1", [appId]);
      await eraseAppData(report, appId);
      await del(report, "vendo_grants", "app_id = $1", [appId]);
      await del(report, "vendo_audit", "app_id = $1", [appId]);
      await del(report, "vendo_records", "refs @> $1::jsonb", [appRef]);
      await del(report, "vendo_mcp_clients", "refs @> $1::jsonb", [appRef]);
      await del(report, "vendo_mcp_grants", "refs @> $1::jsonb", [appRef]);
      return report;
    },
  };
}

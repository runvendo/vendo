import { isoDateTimeSchema, type IsoDateTime } from "@vendoai/core";
import { overlayFor } from "./ephemeral.js";
import { dbFor, type VendoStore } from "./store.js";
import { invalid } from "./validate.js";

/** 02-store §5 — every table in §2's public map. The erase API cascades the
 *  matching data across all of them; `vendo_meta` holds schema metadata (schema
 *  version, boot id), never user data, so no selector ever matches it and its
 *  count stays 0 — listed so the report provably covers the whole map. */
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
] as const;

export type EraseTable = typeof ERASE_TABLES[number];

/** Rows deleted per table (durable rows and ephemeral-overlay rows combined). */
export type EraseReport = Record<EraseTable, number>;

function emptyReport(): EraseReport {
  return Object.fromEntries(ERASE_TABLES.map((table) => [table, 0])) as EraseReport;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Latest of the defined ISO timestamps (all share the sortable ISO format). */
function latest(...times: Array<string | undefined>): string {
  return times.filter((time): time is string => time !== undefined).sort().at(-1) ?? "";
}

/**
 * 02-store §5 — the store-level erase API: by subject (full erasure), by app,
 * or by age, cascading the matching data across all 13 tables of §2's map.
 * It is the ONLY sanctioned deletion path for `vendo_audit` rows — the routed
 * door refuses audit deletion (§2); this API reaches the tables directly.
 * Ephemeral-overlay rows are erased alongside their durable counterparts.
 * Policy engines and schedulers stay out of scope: hosts call this from their
 * own jobs, and host SQL remains available for everything else.
 */
export function eraseStore(store: VendoStore): {
  /** Full erasure of one subject: their apps (and each app's records, blobs,
      state, and runs), plus every subject-keyed or subject-ref'd row. */
  bySubject(subject: string): Promise<EraseReport>;
  /** Erase one app: its row, record collections, blob namespaces, state, runs,
      app-scoped grants and audit rows, and app-ref'd generic/door rows.
      (Threads and approvals have no app axis in §2 — the subject and age
      selectors cover them.) */
  byApp(appId: string): Promise<EraseReport>;
  /** Retention sweep: erase rows whose LAST ACTIVITY predates the cutoff —
      `updated_at` where the table has one (for secrets, falling back to
      `created_at` on legacy rows), otherwise the row's own lifecycle
      timestamps (audit `at`; blobs `created_at`; the latest of
      granted/revoked/expires for grants, created/decided/consumed for
      approvals, started/finished for runs). */
  byAge(olderThan: IsoDateTime): Promise<EraseReport>;
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

  /** App-scoped durable data shared by the subject and app cascades: the app's
      record collections and blob namespaces (`app:<appId>:...` — §3's naming
      convention), its per-user state, and its run records. */
  const eraseAppData = async (report: EraseReport, appId: string): Promise<void> => {
    const prefix = `app:${escapeLike(appId)}:%`;
    await del(report, "vendo_records", "collection LIKE $1 ESCAPE '\\'", [prefix]);
    await del(report, "vendo_blobs", "namespace LIKE $1 ESCAPE '\\'", [prefix]);
    await del(report, "vendo_state", "app_id = $1", [appId]);
    await del(report, "vendo_runs", "app_id = $1", [appId]);
  };

  /** The overlay mirror of eraseAppData (02 §4: ephemeral rows live in the
      per-process overlay, not on disk — erased and counted all the same). */
  const eraseOverlayAppData = (report: EraseReport, appId: string): void => {
    const overlay = overlayFor(store);
    const prefix = `app:${appId}:`;
    for (const [collection, records] of overlay.records) {
      if (collection.startsWith(prefix)) {
        report.vendo_records += records.size;
        overlay.records.delete(collection);
      }
    }
    for (const [namespace, blobs] of overlay.blobs) {
      if (namespace.startsWith(prefix)) {
        report.vendo_blobs += blobs.size;
        overlay.blobs.delete(namespace);
      }
    }
    for (const [key, row] of overlay.states) {
      if (row.appId === appId) {
        overlay.states.delete(key);
        report.vendo_state += 1;
      }
    }
    for (const [id, row] of overlay.runs) {
      if (row.appId === appId) {
        overlay.runs.delete(id);
        report.vendo_runs += 1;
      }
    }
  };

  return {
    async bySubject(subject) {
      if (typeof subject !== "string" || subject === "") {
        invalid("erase subject must be a non-empty string");
      }
      const report = emptyReport();
      const overlay = overlayFor(store);
      const subjectRef = JSON.stringify({ subject });

      // The subject's apps drive the app-scoped cascade (records/blobs/state/runs
      // carry the app id, not the subject).
      const owned = new Set<string>(
        (await db.query("SELECT id FROM vendo_apps WHERE subject = $1", [subject])).rows
          .map((row) => String(row["id"])),
      );
      for (const [id, row] of overlay.apps) if (row.subject === subject) owned.add(id);
      for (const appId of owned) {
        await eraseAppData(report, appId);
        eraseOverlayAppData(report, appId);
      }

      // Ordering matters for accurate counts: the app cascade above already
      // removed the subject's own state/run rows, so the subject-level deletes
      // and overlay sweeps below only count rows the cascade did not reach
      // (e.g. this subject's state under ANOTHER owner's app).
      await del(report, "vendo_apps", "subject = $1", [subject]);
      await del(report, "vendo_state", "subject = $1", [subject]);
      await del(report, "vendo_threads", "subject = $1", [subject]);
      await del(report, "vendo_grants", "subject = $1", [subject]);
      await del(report, "vendo_approvals", "subject = $1", [subject]);
      await del(report, "vendo_audit", "subject = $1", [subject]);
      // Generic and door-owned rows carry the subject only as a ref (§2/§3).
      await del(report, "vendo_records", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_mcp_clients", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_mcp_grants", "refs @> $1::jsonb", [subjectRef]);

      for (const [id, row] of overlay.apps) {
        if (row.subject === subject) {
          overlay.apps.delete(id);
          report.vendo_apps += 1;
        }
      }
      for (const [key, row] of overlay.states) {
        if (row.subject === subject) {
          overlay.states.delete(key);
          report.vendo_state += 1;
        }
      }
      for (const [id, row] of overlay.threads) {
        if (row.subject === subject) {
          overlay.threads.delete(id);
          report.vendo_threads += 1;
        }
      }
      for (const [id, grant] of overlay.grants) {
        if (grant.subject === subject) {
          overlay.grants.delete(id);
          report.vendo_grants += 1;
        }
      }
      for (const [id, row] of overlay.approvals) {
        if (row.subject === subject) {
          overlay.approvals.delete(id);
          report.vendo_approvals += 1;
        }
      }
      for (const [id, event] of overlay.audit) {
        if (event.principal.subject === subject) {
          overlay.audit.delete(id);
          report.vendo_audit += 1;
        }
      }
      for (const records of overlay.records.values()) {
        for (const [id, record] of records) {
          if (record.refs?.["subject"] === subject) {
            records.delete(id);
            report.vendo_records += 1;
          }
        }
      }
      overlay.subjects.delete(subject);
      return report;
    },

    async byApp(appId) {
      if (typeof appId !== "string" || appId === "") {
        invalid("erase appId must be a non-empty string");
      }
      const report = emptyReport();
      const overlay = overlayFor(store);
      const appRef = JSON.stringify({ app_id: appId });

      await eraseAppData(report, appId);
      eraseOverlayAppData(report, appId);
      await del(report, "vendo_apps", "id = $1", [appId]);
      await del(report, "vendo_grants", "app_id = $1", [appId]);
      await del(report, "vendo_audit", "app_id = $1", [appId]);
      await del(report, "vendo_records", "refs @> $1::jsonb", [appRef]);
      await del(report, "vendo_mcp_clients", "refs @> $1::jsonb", [appRef]);
      await del(report, "vendo_mcp_grants", "refs @> $1::jsonb", [appRef]);

      if (overlay.apps.delete(appId)) report.vendo_apps += 1;
      for (const [id, grant] of overlay.grants) {
        if (grant.appId === appId) {
          overlay.grants.delete(id);
          report.vendo_grants += 1;
        }
      }
      for (const [id, event] of overlay.audit) {
        if (event.appId === appId) {
          overlay.audit.delete(id);
          report.vendo_audit += 1;
        }
      }
      for (const records of overlay.records.values()) {
        for (const [id, record] of records) {
          if (record.refs?.["app_id"] === appId) {
            records.delete(id);
            report.vendo_records += 1;
          }
        }
      }
      return report;
    },

    async byAge(olderThan) {
      const parsed = isoDateTimeSchema.safeParse(olderThan);
      if (!parsed.success) invalid("erase olderThan must be an ISO date-time");
      const cutoff = parsed.data;
      const report = emptyReport();

      await del(report, "vendo_apps", "updated_at < $1", [cutoff]);
      await del(report, "vendo_records", "updated_at < $1", [cutoff]);
      await del(report, "vendo_blobs", "created_at < $1", [cutoff]);
      await del(report, "vendo_state", "updated_at < $1", [cutoff]);
      await del(report, "vendo_threads", "updated_at < $1", [cutoff]);
      // GREATEST ignores NULLs: a grant/approval/run is erased only when its
      // ENTIRE lifecycle (including a set expiry or decision) predates the cutoff.
      await del(report, "vendo_grants", "GREATEST(granted_at, revoked_at, expires_at) < $1", [cutoff]);
      await del(report, "vendo_approvals", "GREATEST(created_at, decided_at, consumed_at) < $1", [cutoff]);
      await del(report, "vendo_audit", "at < $1", [cutoff]);
      await del(report, "vendo_runs", "GREATEST(started_at, finished_at) < $1", [cutoff]);
      // A rotated secret is recent activity even when created_at is old;
      // legacy rows (updated_at NULL) fall back to created_at.
      await del(report, "vendo_secrets", "COALESCE(updated_at, created_at) < $1", [cutoff]);
      await del(report, "vendo_mcp_clients", "updated_at < $1", [cutoff]);
      await del(report, "vendo_mcp_grants", "updated_at < $1", [cutoff]);

      const overlay = overlayFor(store);
      const sweep = <T>(map: Map<string, T>, table: EraseTable, lastActivity: (row: T) => string): void => {
        for (const [key, row] of map) {
          if (lastActivity(row) < cutoff) {
            map.delete(key);
            report[table] += 1;
          }
        }
      };
      sweep(overlay.apps, "vendo_apps", (row) => row.updatedAt);
      sweep(overlay.states, "vendo_state", (row) => row.updatedAt);
      sweep(overlay.threads, "vendo_threads", (row) => row.updatedAt);
      sweep(overlay.grants, "vendo_grants", (grant) => latest(grant.grantedAt, grant.revokedAt, grant.expiresAt));
      sweep(overlay.approvals, "vendo_approvals", (row) => latest(row.createdAt, row.decidedAt, row.consumedAt));
      sweep(overlay.audit, "vendo_audit", (event) => event.at);
      sweep(overlay.runs, "vendo_runs", (row) => latest(row.startedAt, row.finishedAt));
      for (const records of overlay.records.values()) {
        for (const [id, record] of records) {
          if (record.updatedAt < cutoff) {
            records.delete(id);
            report.vendo_records += 1;
          }
        }
      }
      // Overlay blobs carry no timestamps (02 §4): they never touch disk and die
      // with close(), so the age axis applies to the durable table only.
      return report;
    },
  };
}

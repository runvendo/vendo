import { encodeGrantPrincipal, engineAppHistory, type FilesAdapter } from "@vendoai/core";
import { escapeLike } from "./helpers/utils.js";
import { dbFor, type VendoStore } from "./store.js";
import { invalid } from "./validate.js";

/** 02-store §5 — every table in §2's public map. The erase API cascades the
 *  matching data across all of them; `vendo_meta` holds schema metadata (schema
 *  version, boot id), never user data, so no selector ever matches it and its
 *  count stays 0 — as does `vendo_secrets` (name-keyed host config, likewise
 *  never matched by a subject or app selector). Listed so the report provably
 *  covers the whole map.
 *
 *  `vendo_effects` used to be in that same never-matched class, because the
 *  frozen v1 shape had no subject column — its `outcome` holds real tool output
 *  and survived an erase forever. The 2026-07-30 contract amendment added
 *  `subject`, so the subject axis now reaches it like any other owned table.
 *
 *  `vendo_quarantine` (v9) is emphatically NOT in that class. A retention sweep
 *  lifts rows out of a live collection, and they are still the same person's
 *  data on the other side — so the sweep copies each row's subject and app id
 *  into columns on the way in (retention.ts) and both cascades below match
 *  them. Without that, quarantining would be a way for data to outlive an
 *  erasure, which is the exact hole `vendo_effects` sat in.
 *
 *  `vendo_idempotency_ledger` (v8) is in the never-matched class TODAY, and not
 *  because it holds nothing: `result` is a recorded response body and can carry
 *  the caller's own data. Its key is (tenant, op, key) and its shape is the
 *  console's, so no subject or app selector can reach a row — the same gap
 *  `vendo_effects` sat in until it was given a subject. Listed here so the gap
 *  is visible in the report rather than forgotten in the schema. */
export const ERASE_TABLES = [
  "vendo_meta",
  "vendo_apps",
  "vendo_records",
  "vendo_blobs",
  "vendo_state",
  "vendo_threads",
  "vendo_thread_messages",
  "vendo_effects",
  "vendo_grants",
  "vendo_approvals",
  "vendo_audit",
  "vendo_automations",
  "vendo_runs",
  "vendo_secrets",
  "vendo_mcp_clients",
  "vendo_mcp_grants",
  "vendo_knowledge_docs",
  "vendo_knowledge_chunks",
  "vendo_workspace_files",
  "vendo_workspace_history",
  "vendo_app_grants",
  "vendo_idempotency_ledger",
  "vendo_quarantine",
  "vendo_usage",
] as const;

export type EraseTable = typeof ERASE_TABLES[number];

/** Rows deleted per table, plus the workspace content deleted behind the files
 *  adapter, plus a count of the workspace content objects erased. That last is
 *  its own axis because a workspace file's content is EITHER inline in the row
 *  OR a blob reached through `blob_ref` (the row is the only pointer), and with
 *  a host-wired `files:` adapter the blobs are not `vendo_blobs` rows at all —
 *  so neither the table counts nor `vendo_blobs` alone tell a GDPR audit how
 *  many pieces of user content this erase actually destroyed.
 *
 *  It is a COUNT OF OBJECTS, never bytes: one per content-bearing workspace row
 *  removed, inline or blob. The name says `objects` because that is the unit it
 *  measures. */
export type EraseReport = Record<EraseTable, number> & { workspace_content_objects: number };

function emptyReport(): EraseReport {
  return {
    ...Object.fromEntries(ERASE_TABLES.map((table) => [table, 0])) as Record<EraseTable, number>,
    workspace_content_objects: 0,
  };
}

/**
 * 02-store §5 — the store-level erase API: by subject (full erasure) or by
 * app, cascading the matching data across every table of §2's map (the count
 * lives in `ERASE_TABLES`, which the conformance suite pins to the DDL). It is
 * the ONLY sanctioned deletion path for `vendo_audit` rows — the routed door
 * refuses audit deletion (§2); this API reaches the tables directly.
 * Policy engines and schedulers stay out of scope: hosts call this from their
 * own jobs, and host SQL remains available for everything else.
 */
export function eraseStore(store: VendoStore, options: { files: FilesAdapter }): {
  /** Full erasure of one subject: their apps (and each app's records, blobs and
      state), their automations and the runs those fired, plus every
      subject-keyed or subject-ref'd row. */
  bySubject(subject: string): Promise<EraseReport>;
  /** Erase one app: its row, record collections, blob namespaces, state,
      app-scoped grants and audit rows, and app-ref'd generic/door rows.
      (Threads, approvals and — since v11 — runs have no app axis: the subject
      selector covers them, through their automation in the runs' case.) */
  byApp(appId: string): Promise<EraseReport>;
} {
  const db = dbFor(store);
  // Workspace content past the inline cap lives behind the files adapter, and
  // `blob_ref` is its ONLY pointer (workspace-rows mints random ids), so the
  // cascade has to read the refs off the rows it deletes. The adapter is
  // REQUIRED, not defaulted: defaulting to the store-backed one let a host with
  // a wired bucket erase the rows and silently keep the objects. Pass the same
  // adapter the workspace was opened with (`storeFiles(store)` when none).
  const files = options.files;

  /** Delete workspace rows and the blobs they were the only pointer to. */
  const delWorkspace = async (
    report: EraseReport,
    table: "vendo_workspace_files" | "vendo_workspace_history",
    where: string,
    params: unknown[],
  ): Promise<void> => {
    const result = await db.query(
      `DELETE FROM ${table} WHERE ${where} RETURNING content, blob_ref`,
      params,
    );
    report[table] += result.rows.length;
    for (const row of result.rows) {
      const ref = row["blob_ref"];
      if (typeof ref === "string") {
        // A blob object: delete it through the adapter and count it.
        await files.delete(ref);
        report.workspace_content_objects += 1;
      } else if (typeof row["content"] === "string") {
        // Inline content: no separate object to delete (it left with the row),
        // but it is still a piece of user content this erase destroyed.
        report.workspace_content_objects += 1;
      }
    }
  };

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
      convention) and its per-user state. */
  const eraseAppData = async (report: EraseReport, appId: string): Promise<void> => {
    const prefix = `app:${escapeLike(appId)}:%`;
    await del(report, "vendo_records", "collection LIKE $1 ESCAPE '\\'", [prefix]);
    // The capped version log (and the pin-intent trail inside it) is the one
    // app-scoped drawer neither selector could see: its name is
    // `vendo:app-history:<id>`, not the `app:<id>:` prefix above, and its rows
    // carry NO refs at all (apps/src/server/persistence/history.ts:104), so the
    // refs containment leg below never matched them either. Every stored version
    // of every deleted app survived its app until this line existed. Named
    // through core's ONE builder — the same one that composes it on the write
    // side — so the two can never drift apart.
    await del(report, "vendo_records", "collection = $1", [engineAppHistory(appId)]);
    await del(report, "vendo_blobs", "namespace LIKE $1 ESCAPE '\\'", [prefix]);
    await del(report, "vendo_state", "app_id = $1", [appId]);
    // Build contract §9.2: an app that is gone grants nothing to anyone.
    await del(report, "vendo_app_grants", "app_id = $1", [appId]);
    // Whatever a retention sweep already lifted out of those drawers. Two
    // selectors, because the live rows needed two: the app id the sweep copied
    // off the row, and the app-history collection, whose rows carry their app
    // only in the collection NAME and no refs at all — the same blind spot
    // that hid the version log from this cascade until it was named above.
    await del(report, "vendo_quarantine", "app_id = $1 OR collection = $2", [
      appId,
      engineAppHistory(appId),
    ]);
  };

  return {
    async bySubject(subject) {
      if (typeof subject !== "string" || subject === "") {
        invalid("erase subject must be a non-empty string");
      }
      const report = emptyReport();
      const subjectRef = JSON.stringify({ subject });

      // The subject's apps drive the app-scoped cascade (records/blobs/state
      // carry the app id, not the subject). The app ROWS are deleted FIRST:
      // once they are gone, no new gated write (records/blobs WHERE EXISTS)
      // can land, so the data deletes below collect any stragglers — the
      // remaining race residue is a write statement already in flight.
      // Build contract §9.7: the org outlives the person. `subject = $1` is the
      // whole rule — an org-owned app carries the ORG id in `subject` (§9.5),
      // so erasing a member never reaches it. What DOES go is the member's own
      // access to org apps: their `user:<subject>` grant rows, below.
      const owned = (await db.query("SELECT id FROM vendo_apps WHERE subject = $1", [subject])).rows
        .map((row) => String(row["id"]));
      await del(report, "vendo_apps", "subject = $1", [subject]);
      for (const appId of owned) await eraseAppData(report, appId);

      // Ordering matters for accurate counts: the app cascade above already
      // removed the subject's own state rows, so the subject-level deletes
      // below only count rows the cascade did not reach (e.g. this subject's
      // state under ANOTHER owner's app).
      await del(report, "vendo_state", "subject = $1", [subject]);
      // v6: the transcript rows hang off the thread row, which owns the subject.
      // Delete them BEFORE the thread row, or the join that identifies them is
      // already gone and the messages outlive the erase.
      await del(
        report,
        "vendo_thread_messages",
        "thread_id IN (SELECT id FROM vendo_threads WHERE subject = $1)",
        [subject],
      );
      await del(report, "vendo_threads", "subject = $1", [subject]);
      // v11: the automation record belongs to the person who armed it, and it
      // carries their webhook signing key — a live secret, so a record that
      // survived an erasure would be a hole and not an untidiness. Its runs are
      // deleted FIRST, while the join that identifies them still exists (the
      // vendo_thread_messages lesson); a run names no subject of its own.
      await del(
        report,
        "vendo_runs",
        "automation_id IN (SELECT id FROM vendo_automations WHERE subject = $1)",
        [subject],
      );
      await del(report, "vendo_automations", "subject = $1", [subject]);
      await del(report, "vendo_grants", "subject = $1", [subject]);
      // The effect ledger's receipts carry tool output (contract amendment
      // 2026-07-30), so they go with the subject's data.
      await del(report, "vendo_effects", "subject = $1", [subject]);
      await del(report, "vendo_approvals", "subject = $1", [subject]);
      await del(report, "vendo_audit", "subject = $1", [subject]);
      // Generic and door-owned rows carry the subject only as a ref (§2/§3).
      await del(report, "vendo_records", "refs @> $1::jsonb", [subjectRef]);
      // Rows a retention sweep already lifted are still this person's data;
      // the sweep copied their subject into a column of its own precisely so
      // this selector reaches them (01 §12, retention.ts).
      await del(report, "vendo_quarantine", "subject = $1", [subject]);
      // The meter counts a PERSON, so its rows are that person's data. They go
      // with them, and the limit they were counted against resets — which is
      // the honest outcome: there is no one left to hold to it. That includes
      // their contribution to any SHARED pool meter, so pooled usage is
      // credited back on erase — accepted: erase is a host-admin operation, and
      // deleting a person's data wins over pool accounting.
      await del(report, "vendo_usage", "subject = $1", [subject]);
      // An appData file twin carries no refs: its owner is the leading key leg
      // (`<owner>/<key>`) inside the app's own namespace. For the subject's own
      // apps the cascade above already took them with the namespace, but a
      // PROMOTED org app belongs to the ORG (§9.7 — `subject = $1` never
      // reaches it), so without this selector a departing member's files inside
      // an org app would outlive them.
      await del(
        report,
        "vendo_blobs",
        "namespace LIKE 'app:%' AND key LIKE $1 ESCAPE '\\'",
        [`${escapeLike(subject)}/%`],
      );
      await del(report, "vendo_mcp_clients", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_mcp_grants", "refs @> $1::jsonb", [subjectRef]);
      // Knowledge corpus rows the subject axis reaches carry the subject only as
      // a ref, same as the door tables (the knowledge engine owns what it refs).
      await del(report, "vendo_knowledge_docs", "refs @> $1::jsonb", [subjectRef]);
      await del(report, "vendo_knowledge_chunks", "refs @> $1::jsonb", [subjectRef]);
      // The workspace (build contract §3.3) is keyed by `owner`, which for
      // /user paths IS the subject — their files, every superseded revision,
      // and the content each row points at.
      await delWorkspace(report, "vendo_workspace_files", "owner = $1", [subject]);
      await delWorkspace(report, "vendo_workspace_history", "owner = $1", [subject]);
      // The person's grants ON OTHER PEOPLE'S apps (§9.2's `user:<subject>`
      // encoding, through the ONE encoder so a surface can never write a shape
      // this cannot match). Team and org grants name no person, so they stay:
      // they describe the org's arrangement, which the departure does not change.
      await del(report, "vendo_app_grants", "principal = $1", [
        encodeGrantPrincipal({ kind: "user", subject }),
      ]);
      // ...but the leaver's name is also on every grant they WROTE (§9.2's
      // `created_by`, kept for audit). Deleting those rows would revoke a team's
      // access because the person who set it up left, so the arrangement stays
      // and the identifier goes. A redaction, not a deletion — it is deliberately
      // absent from the report, which counts rows destroyed.
      await db.query("UPDATE vendo_app_grants SET created_by = '' WHERE created_by = $1", [subject]);
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
      // An app's knowledge corpus (docs + their chunks) goes with the app.
      await del(report, "vendo_knowledge_docs", "refs @> $1::jsonb", [appRef]);
      await del(report, "vendo_knowledge_chunks", "refs @> $1::jsonb", [appRef]);
      // The app's workspace documents. `/user/apps/<appId>/…` is the frozen
      // path layout (build contract §3.1) with the app id verbatim, so they are
      // addressable without knowing whose workspace holds them. Anchored at the
      // mount, so a user file that merely happens to live under a path like
      // `/user/files/apps/<appId>/` is not swept up with the app. Wave 3 adds
      // the second anchor: a promoted app's documents live under
      // `/orgs/<orgId>/apps/<appId>/` (§9.5), and the app id is the same
      // verbatim id, so one `%` covers every org that could hold it.
      // Each anchor is TWO patterns: the subtree, and the subtree's own root row
      // at exactly `…/apps/<appId>` — the path core's `appOfOrgPath` says the
      // app's grants govern, which a slash-suffixed LIKE never matched.
      const user = `/user/apps/${escapeLike(appId)}`;
      const org = `/orgs/%/apps/${escapeLike(appId)}`;
      const anchors = [`${user}/%`, user, `${org}/%`, org];
      const where = anchors.map((_, index) => `path LIKE $${index + 1} ESCAPE '\\'`).join(" OR ");
      await delWorkspace(report, "vendo_workspace_files", where, anchors);
      await delWorkspace(report, "vendo_workspace_history", where, anchors);
      return report;
    },
  };
}

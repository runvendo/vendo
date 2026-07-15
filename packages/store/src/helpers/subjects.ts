import { isReservedSubject, VendoError } from "@vendoai/core";
import { isEphemeralSubject, overlayFor } from "../ephemeral.js";
import { dbFor, type VendoStore } from "../store.js";

/** What an anonymous→signed-in merge moved (block-actions design §C). */
export interface SubjectMergeReport {
  apps: number;
  threads: number;
  states: number;
  /** Rows whose id already existed durably — NEVER overwritten (a merge cannot
      steal or replace another subject's data); the anonymous copy is dropped. */
  skipped: number;
}

/** Block-actions design §C — anonymous→signed-in auto-merge. One of the two
    sanctioned doors through 02-store §2's "rows never cross subjects": the
    first authenticated request carrying a valid anonymous cookie adopts the
    anonymous session's threads, apps (with their per-app record/blob
    collections), and state into the signed-in subject.

    Deliberately NOT migrated — consent does not transfer identities:
      - grants and approvals (users re-approve as themselves),
      - connected accounts (Composio keys them by subject; users reconnect),
      - audit and run history (history is a record of what the anonymous
        principal did; it is not rewritten).

    Idempotent: an anonymous subject that was never registered (or was already
    merged) returns null and moves nothing. Conflicting ids are skipped, never
    stolen: an existing durable row always wins, whoever owns it. */
export async function adoptEphemeralSubject(
  store: VendoStore,
  from: string,
  to: string,
): Promise<SubjectMergeReport | null> {
  if (from === to) throw new VendoError("validation", "cannot merge a subject into itself");
  if (isReservedSubject(to)) {
    throw new VendoError("validation", "cannot merge an anonymous session into a reserved subject");
  }
  if (isEphemeralSubject(store, to)) {
    throw new VendoError("validation", "cannot merge an anonymous session into an ephemeral subject");
  }
  const overlay = overlayFor(store);
  if (!overlay.subjects.has(from)) return null;
  const db = dbFor(store);
  const report: SubjectMergeReport = { apps: 0, threads: 0, states: 0, skipped: 0 };

  // Apps: insert under the new subject, preserving timestamps. ON CONFLICT DO
  // NOTHING is the anti-steal guard — if ANY durable app already has this id
  // (the target's own or a foreign subject's), the durable row wins untouched.
  const fromApps: string[] = [];
  const adopted: string[] = [];
  for (const [id, row] of [...overlay.apps]) {
    if (row.subject !== from) continue;
    fromApps.push(id);
    const result = await db.query(
      `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, to, row.enabled, JSON.stringify(row.doc), row.createdAt, row.updatedAt],
    );
    overlay.apps.delete(id);
    if (result.rows[0] !== undefined) {
      adopted.push(id);
      report.apps += 1;
    } else {
      report.skipped += 1;
    }
  }

  // Threads: same shape, same anti-steal guard.
  for (const [id, row] of [...overlay.threads]) {
    if (row.subject !== from) continue;
    const result = await db.query(
      `INSERT INTO vendo_threads (id, subject, messages, title, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, to, JSON.stringify(row.messages), row.title ?? null, row.createdAt, row.updatedAt],
    );
    overlay.threads.delete(id);
    if (result.rows[0] !== undefined) report.threads += 1;
    else report.skipped += 1;
  }

  // Per-app state rows move to the new subject. The (app_id, subject) PK plus
  // DO NOTHING means state the signed-in subject already has for the same app
  // wins over the anonymous copy.
  for (const [key, row] of [...overlay.states]) {
    if (row.subject !== from) continue;
    const result = await db.query(
      `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (app_id, subject) DO NOTHING RETURNING app_id`,
      [row.appId, to, JSON.stringify(row.data), row.updatedAt, row.createdAt],
    );
    overlay.states.delete(key);
    if (result.rows[0] !== undefined) report.states += 1;
    else report.skipped += 1;
  }

  // App-declared collections (`app:<appId>:<name>` records and blobs, 06 §6)
  // travel with app ownership: once the app row is durable, createRecordStore/
  // createBlobStore route these collections durably, so the in-memory copies
  // must land in the tables or the adopted app would lose its data.
  for (const [collection, records] of [...overlay.records]) {
    const owner = /^app:([^:]+):/.exec(collection)?.[1];
    if (owner === undefined || !adopted.includes(owner)) continue;
    for (const record of records.values()) {
      await db.query(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::bigint)
         ON CONFLICT (collection, id) DO NOTHING`,
        [collection, record.id, JSON.stringify(record.data ?? null),
          record.refs === undefined ? null : JSON.stringify(record.refs),
          record.createdAt, record.updatedAt, record.revision ?? "1"],
      );
    }
    overlay.records.delete(collection);
  }
  for (const [namespace, blobs] of [...overlay.blobs]) {
    const owner = /^app:([^:]+):/.exec(namespace)?.[1];
    if (owner === undefined || !adopted.includes(owner)) continue;
    for (const [key, blob] of blobs) {
      await db.query(
        `INSERT INTO vendo_blobs (namespace, key, bytes, content_type, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace, key) DO NOTHING`,
        [namespace, key, blob.bytes, blob.contentType ?? null, new Date().toISOString()],
      );
    }
    overlay.blobs.delete(namespace);
  }

  // Everything else the anonymous subject accrued is deliberately dropped:
  // grants, approvals, audit, and runs of its apps evaporate with the session.
  for (const [id, grant] of [...overlay.grants]) {
    if (grant.subject === from) overlay.grants.delete(id);
  }
  for (const [id, approval] of [...overlay.approvals]) {
    if (approval.subject === from) overlay.approvals.delete(id);
  }
  for (const [id, event] of [...overlay.audit]) {
    if (event.principal.subject === from) overlay.audit.delete(id);
  }
  for (const [id, run] of [...overlay.runs]) {
    if (fromApps.includes(run.appId)) overlay.runs.delete(id);
  }
  overlay.subjects.delete(from);
  return report;
}

/** Block-actions design §C — the other sanctioned subject-move door: transfer
    a durable app (and its trigger, if any — automations are apps) to an org
    subject. Atomic: the UPDATE applies only while the app still belongs to
    `from`, so a concurrent transfer or foreign app refuses without a TOCTOU
    window. Grants and approvals do NOT follow the app (consent does not
    transfer identities): standing grants stay with the original subject and
    the org re-approves as itself. */
export async function transferAppSubject(
  store: VendoStore,
  appId: string,
  from: string,
  to: string,
): Promise<void> {
  if (overlayFor(store).apps.has(appId)) {
    throw new VendoError("validation", "an ephemeral session's app cannot be transferred; sign in first");
  }
  const db = dbFor(store);
  const result = await db.query(
    `UPDATE vendo_apps SET subject = $3, updated_at = $4
     WHERE id = $1 AND subject = $2 RETURNING id`,
    [appId, from, to, new Date().toISOString()],
  );
  if (result.rows[0] === undefined) {
    throw new VendoError("conflict", `app ${appId} does not belong to the transferring subject`);
  }
}

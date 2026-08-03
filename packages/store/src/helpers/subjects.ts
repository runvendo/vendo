import { isReservedSubject, VendoError, type FilesAdapter } from "@vendoai/core";
import { isEphemeralSubject } from "../sessions.js";
import { dbFor, type VendoStore } from "../store.js";

/** What an anonymous→signed-in merge moved (block-actions design §C). */
export interface SubjectMergeReport {
  apps: number;
  threads: number;
  states: number;
  /** Workspace files carried over (build contract §3.3, keyed on `owner`). */
  files: number;
  /** Effect-ledger receipts moved (contract amendment 2026-07-30). Load-bearing:
      leaving them under the retired anonymous id would strand the proof that a
      mutation already happened, so a re-run after sign-in could charge twice. */
  effects: number;
  /** Rows whose slot the signed-in subject already owned — NEVER overwritten
      (a merge cannot replace the target's data); the anonymous copy is dropped. */
  skipped: number;
}

/** Block-actions design §C — anonymous→signed-in auto-merge. One of the two
    sanctioned doors through 02-store §2's "rows never cross subjects": the
    first authenticated request carrying a valid anonymous cookie adopts the
    anonymous session's threads, apps (with their per-app record/blob
    collections, which travel with app ownership), and state into the
    signed-in subject.

    Deliberately NOT migrated — consent does not transfer identities:
      - grants and approvals (users re-approve as themselves),
      - connected accounts (Composio keys them by subject; users reconnect),
      - audit and run history (history is a record of what the anonymous
        principal did; it is not rewritten),
      - app-access grants (build contract §9.2). An ephemeral visitor can hold
        no org grant by construction — the host asserts memberships for a
        signed-in person, and an anonymous session has none — so there is
        nothing to carry. Adopting them anyway would mean minting access to
        someone else's app out of a cookie, which is the one thing sharing
        must never do.
    The dropped rows are DELETED with the session (kill-list B3: anonymous rows
    are disk rows now).

    Idempotent: an anonymous subject that was never registered (or was already
    merged) returns null and moves nothing. Nothing is ever stolen: apps and
    threads are keyed by unique ids the write doors already refuse to flip
    across subjects, and a state row that collides with one the signed-in
    subject already owns is skipped, never overwritten. */
export async function adoptEphemeralSubject(
  store: VendoStore,
  from: string,
  to: string,
  options: { files: FilesAdapter },
): Promise<SubjectMergeReport | null> {
  if (from === to) throw new VendoError("validation", "cannot merge a subject into itself");
  if (isReservedSubject(to)) {
    throw new VendoError("validation", "cannot merge an anonymous session into a reserved subject");
  }
  if (await isEphemeralSubject(store, to)) {
    throw new VendoError("validation", "cannot merge an anonymous session into an ephemeral subject");
  }
  const db = dbFor(store);
  // Claim-first serialization with the TTL sweep (sessions.ts): deleting the
  // session row is the mutual-exclusion point. Losing the claim means the
  // subject was never registered, was already merged, or a concurrent sweep
  // owns it — this merge moves nothing. Winning it means no sweep can erase
  // the subject's rows while they are moved. The trade: a transient failure
  // MID-merge (after the claim) strands the unmoved remainder as unregistered
  // rows a retry can no longer see — bounded by 02 §4's lingers-like-durable
  // semantics (an explicit erase.bySubject still reaches them).
  const claimed = await db.query(
    "DELETE FROM vendo_sessions WHERE subject = $1 RETURNING 1",
    [from],
  );
  if (claimed.rows[0] === undefined) return null;
  const report: SubjectMergeReport = { apps: 0, threads: 0, states: 0, files: 0, effects: 0, skipped: 0 };

  // Apps move by flipping the subject column. Ids are the vendo_apps PRIMARY
  // KEY and the write doors refuse cross-subject flips, so `from`'s app ids
  // can never collide with anyone else's rows. The app's record collections
  // and blob namespaces (`app:<appId>:...`) are keyed by app id, not subject —
  // they travel with the ownership flip untouched.
  const movedApps = await db.query(
    "UPDATE vendo_apps SET subject = $2 WHERE subject = $1 RETURNING id",
    [from, to],
  );
  report.apps = movedApps.rows.length;

  // Threads: same shape (unique PRIMARY KEY id, door-guarded). Their v6
  // transcript rows are keyed by `thread_id` and carry no subject of their own,
  // so — like an app's record collections above — they travel with this flip
  // untouched. That is deliberate: the thread row is the single ownership
  // record, which is also what lets the message doors scope by joining it.
  const movedThreads = await db.query(
    "UPDATE vendo_threads SET subject = $2 WHERE subject = $1 RETURNING id",
    [from, to],
  );
  report.threads = movedThreads.rows.length;

  // Effect receipts move by subject, the same flip as apps and threads. They are
  // keyed by (runId, tool, input) — never by subject — so a flip can never
  // collide with a receipt the signed-in subject already owns.
  const movedEffects = await db.query(
    "UPDATE vendo_effects SET subject = $2 WHERE subject = $1 RETURNING key",
    [from, to],
  );
  report.effects = movedEffects.rows.length;

  // State is keyed (app_id, subject), so the signed-in subject may already
  // hold a row for the same app — that existing row wins; the anonymous copy
  // is skipped and dropped.
  const movedStates = await db.query(
    `UPDATE vendo_state SET subject = $2 WHERE subject = $1
       AND NOT EXISTS (
         SELECT 1 FROM vendo_state existing
         WHERE existing.app_id = vendo_state.app_id AND existing.subject = $2
       )
     RETURNING app_id`,
    [from, to],
  );
  report.states = movedStates.rows.length;
  const skippedStates = await db.query(
    "DELETE FROM vendo_state WHERE subject = $1 RETURNING app_id",
    [from],
  );
  report.skipped += skippedStates.rows.length;

  // Workspace files travel with the subject: they ARE the anonymous session's
  // apps and notes as files (build contract §3.3, keyed on `owner`). Same rule
  // as state — a path the signed-in subject already holds wins, and the
  // anonymous copy is dropped rather than overwriting it. History rows follow
  // their file, so a path whose file was skipped drops its history too.
  const movedFiles = await db.query(
    `UPDATE vendo_workspace_files SET owner = $2 WHERE owner = $1
       AND NOT EXISTS (
         SELECT 1 FROM vendo_workspace_files existing
         WHERE existing.path = vendo_workspace_files.path AND existing.owner = $2
       )
     RETURNING path`,
    [from, to],
  );
  report.files = movedFiles.rows.length;
  if (report.files > 0) {
    await db.query(
      "UPDATE vendo_workspace_history SET owner = $2 WHERE owner = $1 AND path = ANY($3::text[])",
      [from, to, movedFiles.rows.map((row) => String(row["path"]))],
    );
  }
  // The rows that lost the collision are dropped — and so is the content they
  // pointed at. `blob_ref` is the only pointer (random ids), so skipping this
  // orphans a blob on the MOST COMMON sign-in path. Files that MOVED keep their
  // blobs untouched: the row travelled, and the row is the pointer.
  const files = options.files;
  const dropBlobs = async (rows: Record<string, unknown>[]): Promise<void> => {
    for (const row of rows) {
      const ref = row["blob_ref"];
      if (typeof ref === "string") await files.delete(ref);
    }
  };
  const skippedFiles = await db.query(
    "DELETE FROM vendo_workspace_files WHERE owner = $1 RETURNING path, blob_ref",
    [from],
  );
  report.skipped += skippedFiles.rows.length;
  await dropBlobs(skippedFiles.rows);
  const skippedHistory = await db.query(
    "DELETE FROM vendo_workspace_history WHERE owner = $1 RETURNING blob_ref",
    [from],
  );
  await dropBlobs(skippedHistory.rows);

  // Everything else the anonymous subject accrued is deliberately dropped:
  // grants, approvals, audit, and the run history of its (now adopted) apps.
  await db.query("DELETE FROM vendo_grants WHERE subject = $1", [from]);
  await db.query("DELETE FROM vendo_approvals WHERE subject = $1", [from]);
  await db.query("DELETE FROM vendo_audit WHERE subject = $1", [from]);
  if (report.apps > 0) {
    await db.query(
      "DELETE FROM vendo_runs WHERE app_id = ANY($1::text[])",
      [movedApps.rows.map((row) => String(row["id"]))],
    );
  }
  return report;
}

import { eraseStore } from "./erase.js";
import { dbFor, type VendoStore } from "./store.js";

/** 02-store §4 (kill-list B3) — ephemeral (anonymous) sessions on disk.
 *
 * Anonymous principals write ORDINARY rows under their subject; what makes a
 * session ephemeral is its registration in `vendo_sessions`, and what ends it
 * is the TTL sweep (or adoption on sign-in — helpers/subjects). Registration
 * is the caller's job: the umbrella registers the subject on every
 * ephemeral-principal request (registration == touch), so idle time is
 * measured from the last request, reads included. The store itself stays
 * config-free — TTL policy arrives as an argument. */

/** Touch (or create) an ephemeral session: stamps `touched_at` for the TTL
    sweep. `now` is a millisecond clock reading; the umbrella passes its own
    session clock so tests are deterministic. */
export async function registerEphemeralSubject(
  store: VendoStore,
  subject: string,
  now: number = Date.now(),
): Promise<void> {
  await dbFor(store).query(
    `INSERT INTO vendo_sessions (subject, touched_at) VALUES ($1, $2)
     ON CONFLICT (subject) DO UPDATE SET touched_at = EXCLUDED.touched_at`,
    [subject, new Date(now).toISOString()],
  );
}

/** Whether the subject currently has a registered ephemeral session. */
export async function isEphemeralSubject(store: VendoStore, subject: string): Promise<boolean> {
  const result = await dbFor(store).query(
    "SELECT 1 FROM vendo_sessions WHERE subject = $1",
    [subject],
  );
  return result.rows.length > 0;
}

/** The TTL sweep: erase every registered session idle for at least `idleMs`
    (now - touched_at >= idleMs), cascading through the erase API (02 §5) so a
    swept subject leaves zero rows anywhere. Returns the swept subjects so the
    caller can cascade further (the umbrella forwards them to
    `agent.evictSubject`, 03 §1).

    Claim-first serialization with adoption (helpers/subjects): the sweep owns
    a subject only after winning `DELETE FROM vendo_sessions ... RETURNING` —
    a subject whose session row an interleaved adopt already claimed is
    SKIPPED, so the erase cascade can never chase app ids the adopt just moved
    to the signed-in user. The claim repeats the idleness predicate, so a
    re-touch landing after the stale SELECT (the window is wide — a full erase
    cascade runs between candidates) also defeats it: a live session is never
    erased out from under its visitor. */
export async function sweepEphemeralSubjects(
  store: VendoStore,
  opts: { idleMs: number; now?: number },
): Promise<string[]> {
  const db = dbFor(store);
  const cutoff = new Date((opts.now ?? Date.now()) - opts.idleMs).toISOString();
  const result = await db.query(
    "SELECT subject FROM vendo_sessions WHERE touched_at <= $1 ORDER BY touched_at ASC",
    [cutoff],
  );
  const erase = eraseStore(store);
  const evicted: string[] = [];
  for (const row of result.rows) {
    const subject = String(row["subject"]);
    const claimed = await db.query(
      "DELETE FROM vendo_sessions WHERE subject = $1 AND touched_at <= $2 RETURNING 1",
      [subject, cutoff],
    );
    if (claimed.rows[0] === undefined) continue; // adopted or re-touched mid-sweep — not ours
    await erase.bySubject(subject);
    evicted.push(subject);
  }
  return evicted;
}

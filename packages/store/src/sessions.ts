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

/** The stale-session candidates for a HOST-DRIVEN sweep (the hosted-store
    service exposes this so the umbrella's hosted sweep can list → claim →
    erase over the wire, ending in the erase cascade — 2026-07-18 hosted-store
    one-pager). sweepEphemeralSubjects lists through this too; reading a
    candidate confers no ownership — winning claimEphemeralSubject does. */
export async function listStaleEphemeralSubjects(
  store: VendoStore,
  opts: { idleMs: number; now?: number },
): Promise<string[]> {
  const cutoff = new Date((opts.now ?? Date.now()) - opts.idleMs).toISOString();
  const result = await dbFor(store).query(
    "SELECT subject FROM vendo_sessions WHERE touched_at <= $1 ORDER BY touched_at ASC",
    [cutoff],
  );
  return result.rows.map((row) => String(row["subject"]));
}

/** The claim leg of a sweep (host-driven or sweepEphemeralSubjects): deleting
    the session row is the mutual-exclusion point (the idleness predicate is
    repeated in the claim — a re-touch after the stale listing defeats it, so
    a live session is never erased out from under its visitor). The winner
    owns the subject and MUST follow with the erase cascade. */
export async function claimEphemeralSubject(
  store: VendoStore,
  subject: string,
  opts: { idleMs: number; now?: number },
): Promise<boolean> {
  const cutoff = new Date((opts.now ?? Date.now()) - opts.idleMs).toISOString();
  const result = await dbFor(store).query(
    "DELETE FROM vendo_sessions WHERE subject = $1 AND touched_at <= $2 RETURNING 1",
    [subject, cutoff],
  );
  return result.rows[0] !== undefined;
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
    a subject only after winning `claimEphemeralSubject` — a subject whose
    session row an interleaved adopt already claimed is SKIPPED, so the erase
    cascade can never chase app ids the adopt just moved to the signed-in
    user. The claim repeats the idleness predicate, so a re-touch landing
    after the stale listing (the window is wide — a full erase cascade runs
    between candidates) also defeats it: a live session is never erased out
    from under its visitor. */
export async function sweepEphemeralSubjects(
  store: VendoStore,
  opts: { idleMs: number; now?: number },
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const stale = await listStaleEphemeralSubjects(store, { idleMs: opts.idleMs, now });
  const erase = eraseStore(store);
  const evicted: string[] = [];
  for (const subject of stale) {
    if (!(await claimEphemeralSubject(store, subject, { idleMs: opts.idleMs, now }))) continue; // adopted or re-touched mid-sweep — not ours
    try {
      await erase.bySubject(subject);
    } catch (error) {
      // The claim deleted the session row; a failed cascade must give it back
      // or no later sweep can ever see this subject again and its remaining
      // rows are stranded (the callers log "will retry next interval" — make
      // that true). Restore at the cutoff so it stays sweep-eligible; DO
      // NOTHING keeps a visitor who re-registered mid-erase live. Best
      // effort: if the restore itself fails, the original error still
      // propagates.
      await dbFor(store).query(
        `INSERT INTO vendo_sessions (subject, touched_at) VALUES ($1, $2)
         ON CONFLICT (subject) DO NOTHING`,
        [subject, new Date(now - opts.idleMs).toISOString()],
      ).catch(() => undefined);
      throw error;
    }
    evicted.push(subject);
  }
  return evicted;
}

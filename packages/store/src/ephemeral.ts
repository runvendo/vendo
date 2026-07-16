import type { AuditEvent, PermissionGrant, VendoRecord } from "@vendoai/core";
import type { Db } from "./db.js";
import type { VendoStore } from "./store.js";
import type { AppRow, ApprovalRow, EphemeralStateRow, RunRow, ThreadRow } from "./helpers/types.js";

/** One live ephemeral session (ENG-237). Keyed by subject string in the overlay.
 *  `touchedAt` is the clock reading at the last request that resolved this subject
 *  (touch == registration); `inflight` is the number of in-progress requests
 *  bracketing it, so the idle sweep never evicts a session mid-turn. */
export interface EphemeralSession {
  touchedAt: number;
  inflight: number;
}

/** 02-store §4 */
export interface EphemeralOverlay {
  subjects: Map<string, EphemeralSession>;
  apps: Map<string, AppRow>;
  states: Map<string, EphemeralStateRow>;
  threads: Map<string, ThreadRow>;
  grants: Map<string, PermissionGrant>;
  approvals: Map<string, ApprovalRow>;
  audit: Map<string, AuditEvent>;
  runs: Map<string, RunRow>;
  records: Map<string, Map<string, VendoRecord>>;
  blobs: Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>;
  /** Session clock (ENG-237). Defaults to wall time; the umbrella swaps in an
   *  injected clock (createVendo({ sessions: { now } })) so touch/TTL are
   *  deterministic in tests. Store-internal self-registration reads it too, so
   *  every touch on a subject — door-side or mid-turn — shares one time source. */
  clock: () => number;
  /** Registry cap (ENG-237). Defaults to EPHEMERAL_SUBJECT_CAP; the umbrella
   *  wires sessions.maxSessions here so store-internal self-registrations
   *  enforce the SAME cap as the umbrella's own register calls — otherwise a
   *  host raising maxSessions above the default would have a mid-turn re-touch
   *  (default-cap) mass-evict sessions the umbrella's cap allows. */
  cap: number;
}

const overlays = new WeakMap<object, EphemeralOverlay>();

export function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** 02-store §4 */
export function overlayFor(store: object): EphemeralOverlay {
  let overlay = overlays.get(store);
  if (!overlay) {
    overlay = {
      subjects: new Map(),
      apps: new Map(),
      states: new Map(),
      threads: new Map(),
      grants: new Map(),
      approvals: new Map(),
      audit: new Map(),
      runs: new Map(),
      records: new Map(),
      blobs: new Map(),
      clock: Date.now,
      cap: EPHEMERAL_SUBJECT_CAP,
    };
    overlays.set(store, overlay);
  }
  return overlay;
}

/** ENG-237 test/policy seam: point the overlay's session clock at an injected
 *  time source (the umbrella wires createVendo({ sessions: { now } }) here). */
export function setSessionClock(store: VendoStore, clock: () => number): void {
  overlayFor(store).clock = clock;
}

/** ENG-237 policy seam: set the registry cap the overlay enforces by default
 *  (the umbrella wires createVendo({ sessions: { maxSessions } }) here), so
 *  store-internal self-registrations and umbrella register calls agree. */
export function setSessionCap(store: VendoStore, cap: number): void {
  overlayFor(store).cap = cap;
}

/** app:<appId>:… is the collection/namespace grammar for app-scoped record and
 *  blob stores (01-core §12). The appId segment is colon-free by construction. */
const APP_SCOPE = /^app:([^:]+):/;

/** The owning appId of an app-scoped record collection or blob namespace, or
 *  undefined for non-app-scoped scopes (which are never ephemeral). */
export function appScopeId(scope: string): string | undefined {
  return APP_SCOPE.exec(scope)?.[1];
}

/** Default cap on the ephemeral-subject registry (ENG-251). One anonymous
    visitor per entry; without a bound the registry grows for the life of the
    process as new anonymous clients arrive. ~10k concurrent anonymous sessions
    is a generous ceiling for a single-process OSS host. Overridable through the
    umbrella's `sessions.maxSessions`. */
export const EPHEMERAL_SUBJECT_CAP = 10_000;

/** Declare a subject ephemeral before writing data that only carries its subject
    string, AND stamp its touch time (ENG-237: registration == touch). Bounded
    LRU by registration recency (ENG-251): re-registering an active subject
    refreshes it to the most-recent slot, so the entry evicted when the cap is
    exceeded is always the OLDEST idle subject — never the one being registered
    for the current request.

    Cap overflow now runs the FULL eviction cascade (ENG-237), not the old
    key-only drop: the evicted subject's overlay data is cleared with it, closing
    the ENG-251 trade-off where an over-cap subject's later writes silently began
    persisting to disk and its stale overlay rows were never cleaned. Overflow
    never evicts an inflight subject (a mid-stream turn would lose its overlay
    and its final thread-persist would land on disk — the STORE-1 leak); if every
    other subject is inflight the registry temporarily exceeds the cap instead. */
export function registerEphemeralSubject(
  store: VendoStore,
  subject: string,
  now: number = overlayFor(store).clock(),
  cap: number = overlayFor(store).cap,
): void {
  const subjects = overlayFor(store).subjects;
  const prior = subjects.get(subject);
  // delete+set bumps recency (Map preserves insertion order → first is oldest)
  // while preserving any inflight refcount an in-progress request holds.
  subjects.delete(subject);
  subjects.set(subject, { touchedAt: now, inflight: prior?.inflight ?? 0 });
  if (subjects.size <= cap) return;
  for (const [oldest, session] of subjects) {
    if (oldest === subject || session.inflight > 0) continue;
    evictEphemeralSubject(store, oldest);
    if (subjects.size <= cap) return;
  }
}

export function isEphemeralSubject(store: VendoStore, subject: string): boolean {
  return overlayFor(store).subjects.has(subject);
}

/** Bracket an in-progress request against its ephemeral subject (ENG-237). The
    idle sweep skips any subject with inflight > 0, so a minutes-long streaming
    turn can never have its session swept out from under it, whatever the TTL. */
export function beginEphemeralRequest(store: VendoStore, subject: string): void {
  const session = overlayFor(store).subjects.get(subject);
  if (session !== undefined) session.inflight += 1;
}

export function endEphemeralRequest(store: VendoStore, subject: string): void {
  const session = overlayFor(store).subjects.get(subject);
  if (session !== undefined && session.inflight > 0) session.inflight -= 1;
}

/** Synchronous cascading eviction of one ephemeral subject (ENG-237). Clears
    EVERY overlay map of exactly this subject's data and drops its registry
    entry. No awaits between the first and last mutation, so no concurrent
    request can observe a half-evicted session. Memory-only: while a subject is
    registered none of its writes reach disk, so at eviction time it has zero
    on-disk rows and this touches nothing durable. */
export function evictEphemeralSubject(store: VendoStore, subject: string): void {
  const overlay = overlayFor(store);
  // Apps owned by S — collect their ids so records/blobs/runs (which carry an
  // appId, not a subject) can be matched.
  const appIds = new Set<string>();
  for (const [id, row] of overlay.apps) {
    if (row.subject === subject) {
      appIds.add(id);
      overlay.apps.delete(id);
    }
  }
  for (const [key, row] of overlay.states) {
    if (row.subject === subject) overlay.states.delete(key);
  }
  for (const [id, row] of overlay.threads) {
    if (row.subject === subject) overlay.threads.delete(id);
  }
  for (const [id, grant] of overlay.grants) {
    if (grant.subject === subject) overlay.grants.delete(id);
  }
  for (const [id, row] of overlay.approvals) {
    if (row.subject === subject) overlay.approvals.delete(id);
  }
  for (const [id, event] of overlay.audit) {
    if (event.principal.subject === subject) overlay.audit.delete(id);
  }
  for (const [id, row] of overlay.runs) {
    if (appIds.has(row.appId)) overlay.runs.delete(id);
  }
  for (const collection of overlay.records.keys()) {
    const appId = appScopeId(collection);
    if (appId !== undefined && appIds.has(appId)) overlay.records.delete(collection);
  }
  for (const namespace of overlay.blobs.keys()) {
    const appId = appScopeId(namespace);
    if (appId !== undefined && appIds.has(appId)) overlay.blobs.delete(namespace);
  }
  overlay.subjects.delete(subject);
}

/** Idle sweep (ENG-237): evict every registered subject that is not inflight and
    has been idle for at least idleMs, returning the evicted subjects so the
    caller (the umbrella) can cascade into the agent's in-memory threads. The
    store stays config-free — TTL is umbrella policy passed in as an argument. */
export function sweepEphemeralSubjects(
  store: VendoStore,
  opts: { idleMs: number; now?: number },
): string[] {
  const overlay = overlayFor(store);
  const now = opts.now ?? overlay.clock();
  const evicted: string[] = [];
  for (const [subject, session] of overlay.subjects) {
    if (session.inflight === 0 && now - session.touchedAt >= opts.idleMs) evicted.push(subject);
  }
  for (const subject of evicted) evictEphemeralSubject(store, subject);
  return evicted;
}

/** Tri-state ephemerality of an app-scoped write/read target (ENG-237, STORE-1).
 *  - "ephemeral": an in-overlay app owned by a still-registered subject → route
 *    to the in-memory overlay.
 *  - "durable": a real vendo_apps row (durable apps always have one) → route to
 *    disk.
 *  - "unknown": no overlay app AND no vendo_apps row → the app does not exist
 *    anywhere. The one query the boolean form already ran now also distinguishes
 *    this case, so app-scoped WRITES can fail closed instead of orphaning a disk
 *    row for an app that never existed / whose session was evicted. */
export type AppEphemerality = "ephemeral" | "durable" | "unknown";

export async function appEphemerality(store: VendoStore, db: Db, appId: string): Promise<AppEphemerality> {
  const memoryApp = overlayFor(store).apps.get(appId);
  if (memoryApp) return isEphemeralSubject(store, memoryApp.subject) ? "ephemeral" : "unknown";
  const result = await db.query("SELECT subject FROM vendo_apps WHERE id = $1", [appId]);
  const subject = result.rows[0]?.["subject"];
  if (typeof subject !== "string") return "unknown";
  return isEphemeralSubject(store, subject) ? "ephemeral" : "durable";
}

/** Runs inherit ephemerality from their owning app because run rows have no subject column. */
export async function isEphemeralApp(store: VendoStore, db: Db, appId: string): Promise<boolean> {
  return (await appEphemerality(store, db, appId)) === "ephemeral";
}

/** Read-only overlay map sizes (ENG-237). A test/introspection seam for the
    memory-flatness churn test — NOT a production debug surface. */
export function ephemeralOverlaySizes(store: VendoStore): Record<string, number> {
  const overlay = overlayFor(store);
  return {
    subjects: overlay.subjects.size,
    apps: overlay.apps.size,
    states: overlay.states.size,
    threads: overlay.threads.size,
    grants: overlay.grants.size,
    approvals: overlay.approvals.size,
    audit: overlay.audit.size,
    runs: overlay.runs.size,
    records: overlay.records.size,
    blobs: overlay.blobs.size,
  };
}

export function stateKey(subject: string, appId: string): string {
  return `${subject}\u0000${appId}`;
}

export function dropOverlay(store: object): void {
  const overlay = overlays.get(store);
  if (overlay) {
    overlay.subjects.clear();
    overlay.apps.clear();
    overlay.states.clear();
    overlay.threads.clear();
    overlay.grants.clear();
    overlay.approvals.clear();
    overlay.audit.clear();
    overlay.runs.clear();
    overlay.records.clear();
    overlay.blobs.clear();
  }
  overlays.delete(store);
}

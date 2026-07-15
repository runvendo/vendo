import type { AuditEvent, PermissionGrant, VendoRecord } from "@vendoai/core";
import type { Db } from "./db.js";
import type { VendoStore } from "./store.js";
import type { AppRow, ApprovalRow, EphemeralStateRow, RunRow, ThreadRow } from "./helpers/types.js";

/** 02-store §4 */
export interface EphemeralOverlay {
  subjects: Set<string>;
  apps: Map<string, AppRow>;
  states: Map<string, EphemeralStateRow>;
  threads: Map<string, ThreadRow>;
  grants: Map<string, PermissionGrant>;
  approvals: Map<string, ApprovalRow>;
  audit: Map<string, AuditEvent>;
  runs: Map<string, RunRow>;
  records: Map<string, Map<string, VendoRecord>>;
  blobs: Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>;
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
      subjects: new Set(),
      apps: new Map(),
      states: new Map(),
      threads: new Map(),
      grants: new Map(),
      approvals: new Map(),
      audit: new Map(),
      runs: new Map(),
      records: new Map(),
      blobs: new Map(),
    };
    overlays.set(store, overlay);
  }
  return overlay;
}

/** Cap on the ephemeral-subject set (ENG-251). One anonymous visitor per entry;
    without a bound the set grows for the life of the process as new anonymous
    clients arrive. ~10k concurrent anonymous sessions is a generous ceiling for
    a single-process OSS host. */
const EPHEMERAL_SUBJECT_CAP = 10_000;

/** Declare a subject ephemeral before writing data that only carries its subject
    string. Bounded LRU by registration recency (ENG-251): re-registering an
    active subject refreshes it to the most-recent slot, so the entry evicted
    when the cap is exceeded is always the OLDEST idle subject — never the one
    being registered for the current request.

    Trade-off: an evicted subject's LATER writes route to the DURABLE store
    instead of the in-memory ephemeral overlay, so a very long-idle anonymous
    session could begin persisting. Acceptable — ephemeral sessions are already
    best-effort and never outlive the process — and it buys a fixed memory
    ceiling against anonymous-visitor churn. */
export function registerEphemeralSubject(store: VendoStore, subject: string): void {
  const subjects = overlayFor(store).subjects;
  // delete+add bumps recency (Set preserves insertion order → first is oldest).
  subjects.delete(subject);
  subjects.add(subject);
  while (subjects.size > EPHEMERAL_SUBJECT_CAP) {
    const oldest = subjects.values().next().value;
    if (oldest === undefined) break;
    subjects.delete(oldest);
  }
}

export function isEphemeralSubject(store: VendoStore, subject: string): boolean {
  return overlayFor(store).subjects.has(subject);
}

/** Runs inherit ephemerality from their owning app because run rows have no subject column. */
export async function isEphemeralApp(store: VendoStore, db: Db, appId: string): Promise<boolean> {
  const memoryApp = overlayFor(store).apps.get(appId);
  if (memoryApp) return isEphemeralSubject(store, memoryApp.subject);
  const result = await db.query("SELECT subject FROM vendo_apps WHERE id = $1", [appId]);
  const subject = result.rows[0]?.["subject"];
  return typeof subject === "string" && isEphemeralSubject(store, subject);
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

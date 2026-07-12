import type { AuditEvent, PermissionGrant } from "@vendoai/core";
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
}

const overlays = new WeakMap<object, EphemeralOverlay>();

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
    };
    overlays.set(store, overlay);
  }
  return overlay;
}

/** Declare a subject ephemeral before writing data that only carries its subject string. */
export function registerEphemeralSubject(store: VendoStore, subject: string): void {
  overlayFor(store).subjects.add(subject);
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
  }
  overlays.delete(store);
}

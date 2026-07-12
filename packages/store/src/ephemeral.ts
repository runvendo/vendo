import type { AuditEvent, PermissionGrant } from "@vendoai/core";
import type { AppRow, ApprovalRow, EphemeralStateRow, ThreadRow } from "./helpers/types.js";

/** 02-store §4 */
export interface EphemeralOverlay {
  apps: Map<string, AppRow>;
  states: Map<string, EphemeralStateRow>;
  threads: Map<string, ThreadRow>;
  grants: Map<string, PermissionGrant>;
  approvals: Map<string, ApprovalRow>;
  audit: Map<string, AuditEvent>;
}

const overlays = new WeakMap<object, EphemeralOverlay>();

/** 02-store §4 */
export function overlayFor(store: object): EphemeralOverlay {
  let overlay = overlays.get(store);
  if (!overlay) {
    overlay = {
      apps: new Map(),
      states: new Map(),
      threads: new Map(),
      grants: new Map(),
      approvals: new Map(),
      audit: new Map(),
    };
    overlays.set(store, overlay);
  }
  return overlay;
}

export function stateKey(subject: string, appId: string): string {
  return `${subject}\u0000${appId}`;
}

export function dropOverlay(store: object): void {
  const overlay = overlays.get(store);
  if (overlay) {
    overlay.apps.clear();
    overlay.states.clear();
    overlay.threads.clear();
    overlay.grants.clear();
    overlay.approvals.clear();
    overlay.audit.clear();
  }
  overlays.delete(store);
}

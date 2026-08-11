import { engineOverAdapter, type StoreAdapter, type StoreOps } from "@vendoai/core";

/**
 * Vendo's OWN drawers — app rows, grants, placements, history, the parked
 * cards — reached by name through the store's `engine` family rather than a
 * generic record façade. Same seven verbs, one argument wider, and
 * `assertEngineCollection` gates the name on every one of them, so a
 * collection this package has no business in cannot be reached from here.
 *
 * Generated-app data does NOT come through here: that is `appData`, which
 * stamps an owner (`persistence/app-data.ts`).
 */
export type EngineOps = StoreOps["engine"];

/** The engine family for this deployment. `selectStoreOps` answers `undefined`
    for a store that offers neither its own ops surface nor a SQL handle, and a
    host constructing this block directly passes only a `StoreAdapter` — that
    store gets core's `engineOverAdapter`, which is the same allowlist gate in
    front of the adapter's own record door. Mirrors how automations reaches its
    drawers (`packages/automations/src/engine-context.ts`). */
export const engineOf = (ops: StoreOps | undefined, store: StoreAdapter): EngineOps =>
  ops?.engine ?? engineOverAdapter(store);

import { VendoError, type StoreOps } from "@vendoai/core";

/**
 * Vendo's OWN drawers — app rows, grants, placements, history, the parked
 * cards — reached by name through the store's `engine` family rather than the
 * generic `records` façade. Same seven verbs, one argument wider, and
 * `assertEngineCollection` gates the name on every one of them, so a
 * collection this package has no business in cannot be reached from here.
 *
 * Generated-app data does NOT come through here: that is `appData`, which
 * stamps an owner (`persistence/app-data.ts`).
 */
export type EngineOps = StoreOps["engine"];

/** Deferred, never thrown at compose. `selectStoreOps` answers `undefined` for
    a store that offers neither its own ops nor a SQL handle, and a store like
    that must still BOOT — it refuses at the op that needed one, which is the
    same shape the box-rows door takes (`packages/vendo/src/wire/box.ts`). */
const refuse = (): never => {
  throw new VendoError(
    "not-implemented",
    "Vendo's own app rows need the store's named-operation surface: this deployment needs a "
    + "SQL-backed store (`store: postgres(url)`, or the local default) or a StoreOps-capable "
    + "store (the Cloud hosted store). The configured store is neither.",
  );
};

const REFUSING_ENGINE: EngineOps = {
  get: refuse,
  put: refuse,
  delete: refuse,
  list: refuse,
  claim: refuse,
  insertIfAbsent: refuse,
  compareAndSwap: refuse,
};

/** The engine family for this deployment, or the refusal above. */
export const engineOf = (ops: StoreOps | undefined): EngineOps => ops?.engine ?? REFUSING_ENGINE;

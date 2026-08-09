import { VendoError, type StoreOps } from "@vendoai/core";
// Type-only — erased at compile time, so the engine stays out of this module's
// bundle graph (the same rule store.ts states).
import type { Db } from "../db-postgres.js";
import { maybeDbFor, type VendoStore } from "../store.js";

/** Where a helper's rows actually live for THIS store handle. */
type StoreBackend =
  | { kind: "sql"; db: Db }
  | { kind: "ops"; ops: StoreOps };

/**
 * The one selector every store-shaped helper resolves itself through.
 *
 * A helper like `threadMessageStore` used to open with `dbFor(store)` and throw
 * "Unknown VendoStore handle" for anything this package did not mint — which is
 * every hosted deployment, and is why a key-only host could not serve a harness
 * turn. The rows exist either way; only the road to them differs. So: the SQL
 * handle when there is one, the store's own 31-op surface when there is not, and
 * a named refusal only when the store offers neither.
 *
 * SQL wins when both are present. It is the same database, one hop shorter.
 *
 * `what` names the thing being served, so the refusal reads as a fact about the
 * deployment rather than an internals leak.
 */
export function backendOf(store: VendoStore, what: string): StoreBackend {
  const db = maybeDbFor(store);
  if (db !== undefined) return { kind: "sql", db };
  if (store.ops !== undefined) return { kind: "ops", ops: store.ops };
  throw new VendoError(
    "not-implemented",
    `${what} needs a SQL handle or a StoreOps-capable store; the configured store has neither.`,
  );
}

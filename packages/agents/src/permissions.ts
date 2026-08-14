/**
 * Where this package's permission wire mounts, and who it asks. A library
 * cannot add a route to the host's server, so — exactly like {@link DOOR_PATH}
 * — the handler comes back out of `agent()` for the host to mount. The routes
 * themselves are @vendoai/guard's ONE implementation.
 */
import type { Principal, StoreAdapter } from "@vendoai/core";

/** Where the host mounts {@link VendoAgent.permissions}. `DOOR_PATH` lives
 *  under it, which is why the handler falls THROUGH (undefined) instead of
 *  answering not-found: one catch-all route can serve both. */
export const PERMISSIONS_PATH = "/api/vendo";

/** Who is asking, from the host's own session — the same seam the umbrella's
 *  wire takes. */
export type AgentPrincipal = (request: Request) => Promise<Principal | null>;

/** This mount is a THIRD entry door into the package, and a consent surface can
 *  poll it before the agent's first turn — so it ensures the schema exactly as
 *  `createSession` and the away runner do, or a virgin store answers the first
 *  `GET /approvals` with `relation "vendo_approvals" does not exist`.
 *  Hung on the principal resolver because the wire calls it ONLY for the paths
 *  this mount owns, so a fall-through (the door, someone else's route) still
 *  pays nothing; latched, because a polled surface must not run a migration
 *  check per request. */
export function schemaReadyPrincipal(
  principal: AgentPrincipal,
  store: Pick<StoreAdapter, "ensureSchema">,
): AgentPrincipal {
  let ready: Promise<void> | undefined;
  return async (request) => {
    ready ??= store.ensureSchema();
    await ready;
    return principal(request);
  };
}

/**
 * Where this package's permission wire mounts, and who it asks. A library
 * cannot add a route to the host's server, so — exactly like {@link DOOR_PATH}
 * — the handler comes back out of `agent()` for the host to mount. The routes
 * themselves are @vendoai/guard's ONE implementation.
 */
import type { Principal } from "@vendoai/core";

/** Where the host mounts {@link VendoAgent.permissions}. `DOOR_PATH` lives
 *  under it, which is why the handler falls THROUGH (undefined) instead of
 *  answering not-found: one catch-all route can serve both. */
export const PERMISSIONS_PATH = "/api/vendo";

/** Who is asking, from the host's own session — the same seam the umbrella's
 *  wire takes. */
export type AgentPrincipal = (request: Request) => Promise<Principal | null>;

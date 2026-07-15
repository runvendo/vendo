import type { Principal } from "@vendoai/vendo"
import { resolveCadencePrincipal } from "./auth"

/** Session-backed resolver: the Supabase user id is the Vendo subject.
 * Requests without a session resolve to null and ride the umbrella's
 * per-client anonymous principal — there is no fixed demo principal anymore. */
export async function resolveDemoPrincipal(req: Request): Promise<Principal | null> {
  return resolveCadencePrincipal(req)
}

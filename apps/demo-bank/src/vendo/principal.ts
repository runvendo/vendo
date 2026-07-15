import type { Principal } from "@vendoai/vendo";
import { resolveMaplePrincipal } from "./auth";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function demoRequestAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  const host = req.headers.get("host");
  let hostname = host ? (host.split(":")[0] ?? "") : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/** Session-backed resolver: the Auth.js user id is the Vendo subject. Requests
 * without a session resolve to null and ride the umbrella's per-client
 * anonymous principal — there is no fixed demo principal anymore. */
export async function resolveDemoPrincipal(req: Request): Promise<Principal | null> {
  return resolveMaplePrincipal(req);
}

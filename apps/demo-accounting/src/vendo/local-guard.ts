/**
 * The locality gate for every Vendo route that can drive REAL Composio sends
 * (chat and the scheduler tick). The demo agent acts as the shared, pre-authed
 * Gmail/Calendar subject, so a reachable deployment must NOT let a stranger
 * drive it.
 *
 * Fail closed on a deployment. Dual-review (PR #27) found two gaps in the
 * original Host-header check: (1) the Host header is client-controlled, so
 * `Host: localhost` spoofed the "local" check; (2) the tick route had no gate
 * at all. This guard fixes both:
 *
 *  - `VENDO_DEMO_PUBLIC=1` — explicit operator opt-in, always allowed.
 *  - Otherwise allowed ONLY when NOT a production build AND the request looks
 *    local. Production deployments run `NODE_ENV=production`, so a spoofed
 *    Host header can no longer reach the real principal there; local `pnpm
 *    dev` (NODE_ENV=development) keeps working.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host");
  let hostname = host ? host.split(":")[0] : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/** True when this request may drive the real Composio identity. */
export function demoPrincipalAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
  // Never trust the client Host header on a production build — deployments set
  // NODE_ENV=production, so the spoof path is closed there regardless of Host.
  if (process.env.NODE_ENV === "production") return false;
  return isLocalRequest(req);
}

export const LOCAL_ONLY_MESSAGE =
  "Vendo demo is restricted to local runs. Set VENDO_DEMO_PUBLIC=1 to enable on a deployment.";

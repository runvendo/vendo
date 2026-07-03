/**
 * Request gate + principal resolution, shared by every mutating/identity-
 * bearing endpoint (chat, action, integrations, tick).
 *
 * Default posture (no `principal` option): the handler holds real API keys
 * and the default policy auto-allows reads, so it serves LOCAL requests only.
 * `FLOWLET_ALLOW_REMOTE=1` opts a deployment in explicitly (same escape hatch
 * shape the demo uses). Passing a `principal` resolver replaces the guard
 * entirely — the host's auth becomes the gate, and `null` means 403.
 *
 * IMPORTANT: the local-only check keys off the `Host` header, which is
 * client-controlled (spoofable by a direct caller, rewritable by a proxy). It
 * is a DEV CONVENIENCE, not a production auth control. Anything reachable from
 * the internet MUST pass a `principal` resolver — that is the real gate.
 * (See docs/quickstart.md → Deploying.)
 */
import type { FlowletPrincipal } from "@flowlet/runtime";
import type { FlowletHandlerOptions } from "./options";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** The identity zero-config installs run as (keys Composio connections too). */
export const DEFAULT_PRINCIPAL: FlowletPrincipal = { userId: "flowlet-default-user" };

export const REMOTE_BLOCKED_MESSAGE =
  "Flowlet is restricted to local requests. Pass a `principal` resolver to " +
  "createFlowletHandler (recommended) or set FLOWLET_ALLOW_REMOTE=1 to serve remote traffic.";

function isLocalRequest(req: Request): boolean {
  // Prefer the Host header (authoritative for the served origin); fall back
  // to the request URL's hostname when it is absent.
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

export type GuardResult =
  | { ok: true; principal: FlowletPrincipal }
  | { ok: false; response: Response };

export async function resolvePrincipal(
  req: Request,
  options: FlowletHandlerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<GuardResult> {
  if (options.principal) {
    const principal = await options.principal(req);
    if (principal === null) {
      return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 403 }) };
    }
    return { ok: true, principal };
  }
  if (env["FLOWLET_ALLOW_REMOTE"] === "1" || isLocalRequest(req)) {
    return { ok: true, principal: DEFAULT_PRINCIPAL };
  }
  return {
    ok: false,
    response: Response.json({ error: REMOTE_BLOCKED_MESSAGE }, { status: 403 }),
  };
}

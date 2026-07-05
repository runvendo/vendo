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
 * client-controlled (spoofable by a direct caller, rewritable by a proxy), so
 * it is NOT trusted in production. When `NODE_ENV === "production"` (i.e.
 * `next build && next start`) the default identity is disabled entirely: the
 * handler fails closed unless a `principal` resolver or FLOWLET_ALLOW_REMOTE=1
 * is set. The Host check only relaxes things in development.
 * (See docs/quickstart.md → Deploying.)
 */
import { timingSafeEqual } from "node:crypto";
import type { FlowletPrincipal } from "@flowlet/runtime";
import type { FlowletHandlerOptions } from "./options";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Service auth for POST /tick — an external cron (vercel.json, Cloudflare
 * Cron Trigger) presents `authorization: Bearer <FLOWLET_TICK_SECRET>`.
 *
 *   - "allowed"     — secret configured and the bearer matches (timing-safe).
 *   - "denied"      — secret configured, bearer presented, but WRONG: hard
 *                     401 upstream, never a fall-through to principal auth.
 *   - "unattempted" — no secret configured, or no bearer presented: the
 *                     caller falls through to `resolvePrincipal` unchanged.
 */
export function tickServiceAuth(
  req: Request,
  env: Record<string, string | undefined> = process.env,
): "allowed" | "denied" | "unattempted" {
  const secret = env["FLOWLET_TICK_SECRET"];
  if (!secret) return "unattempted";
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return "unattempted";
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  // timingSafeEqual requires equal lengths; a length mismatch is a mismatch.
  if (presented.length !== expected.length) return "denied";
  return timingSafeEqual(presented, expected) ? "allowed" : "denied";
}

/** The identity zero-config installs run as (keys Composio connections too). */
export const DEFAULT_PRINCIPAL: FlowletPrincipal = { userId: "flowlet-default-user" };

export const REMOTE_BLOCKED_MESSAGE =
  "Flowlet is not serving this request. In production you MUST pass a `principal` " +
  "resolver to createFlowletHandler (recommended) or set FLOWLET_ALLOW_REMOTE=1. " +
  "The default identity is available only to local requests in development.";

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
  // Explicit opt-in wins in any environment.
  if (env["FLOWLET_ALLOW_REMOTE"] === "1") {
    return { ok: true, principal: DEFAULT_PRINCIPAL };
  }
  // FAIL CLOSED in production. `next build && next start` sets NODE_ENV to
  // "production"; a real deployment therefore gets NO default principal and
  // MUST configure `principal` (or FLOWLET_ALLOW_REMOTE=1). This makes the
  // spoofable Host-header check a DEV-ONLY convenience — it can never be the
  // control on a deployed app, closing the "Host: localhost" bypass.
  if (env["NODE_ENV"] === "production") {
    return {
      ok: false,
      response: Response.json({ error: REMOTE_BLOCKED_MESSAGE }, { status: 403 }),
    };
  }
  // Development only: serve local requests with the default identity so
  // zero-config `next dev` just works.
  if (isLocalRequest(req)) {
    return { ok: true, principal: DEFAULT_PRINCIPAL };
  }
  return {
    ok: false,
    response: Response.json({ error: REMOTE_BLOCKED_MESSAGE }, { status: 403 }),
  };
}

/**
 * Request gate + principal resolution, shared by every mutating/identity-
 * bearing endpoint (chat, action, integrations, tick).
 *
 * Default posture (no `principal` option): the handler holds real API keys
 * and the default policy auto-allows reads, so it serves LOCAL requests only.
 * `VENDO_ALLOW_REMOTE=1` opts a deployment in explicitly (same escape hatch
 * shape the demo uses). Passing a `principal` resolver replaces the guard
 * entirely — the host's auth becomes the gate, and `null` means 403.
 *
 * IMPORTANT: the local-only check keys off the `Host` header, which is
 * client-controlled (spoofable by a direct caller, rewritable by a proxy), so
 * it is NOT trusted in production. When `NODE_ENV === "production"` (i.e.
 * `next build && next start`) the default identity is disabled entirely: the
 * handler fails closed unless a `principal` resolver or VENDO_ALLOW_REMOTE=1
 * is set. The Host check only relaxes things in development.
 * (See docs/quickstart.md → Deploying.)
 */
import { timingSafeEqual } from "node:crypto";
import type { Principal } from "@vendoai/core";
import type { VendoPrincipal } from "@vendoai/runtime";
import type { VendoHandlerOptions } from "./options.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Service auth for POST /tick — an external cron (vercel.json, Cloudflare
 * Cron Trigger) presents `authorization: Bearer <VENDO_TICK_SECRET>`.
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
  const secret = env["VENDO_TICK_SECRET"];
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
export const DEFAULT_PRINCIPAL: VendoPrincipal = { userId: "vendo-default-user" };

/**
 * The fixed automations-world scope every embedded install shares (v1 is
 * single-tenant — see world.ts). One place spells the "vendo-embedded"
 * tenant id, so connections storage and webhook routing (which need a
 * core `Principal` before any request-scoped identity exists) agree with
 * the world the handler actually assembled.
 */
export const WORLD_SCOPE: Principal = { tenantId: "vendo-embedded", subject: DEFAULT_PRINCIPAL.userId };

/**
 * Maps a resolved request principal to a thread-store scope: the same fixed
 * tenant as `WORLD_SCOPE` (v1 is single-tenant), subject = the principal's
 * `userId`. This is what gives per-user thread isolation when a host wires a
 * custom `principal` resolver — each distinct userId gets its own thread
 * list — while every install still shares one automations-world tenant.
 */
export function threadScope(principal: VendoPrincipal): Principal {
  return { tenantId: WORLD_SCOPE.tenantId, subject: principal.userId };
}

export const REMOTE_BLOCKED_MESSAGE =
  "Vendo is not serving this request. In production you MUST pass a `principal` " +
  "resolver to createVendoHandler (recommended) or set VENDO_ALLOW_REMOTE=1. " +
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

/**
 * True only for a development-mode request from a local host — the one
 * situation where a deliberately-constructed boot error message may be echoed
 * to the caller (see fetch-handler.ts's bootError). Same Host-header localness
 * `resolvePrincipal` keys on; NODE_ENV=production disables it entirely because
 * that header is client-controlled.
 */
export function isLocalDevRequest(
  req: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env["NODE_ENV"] !== "production" && isLocalRequest(req);
}

/**
 * CSRF gate for browser-credentialed mutating routes. A host `principal`
 * resolver may authenticate via ambient cookies, so a cross-site page could
 * otherwise fire authenticated mutations (POST bodies `req.json()` accepts are
 * "simple requests" that skip the CORS preflight). Two carve-outs keep
 * legitimate callers working:
 *   - an `authorization` header is a custom-header credential a cross-site
 *     page cannot attach without a CORS preflight this handler never grants —
 *     inherently CSRF-safe, no origin check needed;
 *   - a request with NO browser provenance headers (curl, server-to-server)
 *     carries no third-party-triggered ambient credentials.
 * When `Origin` is present it is authoritative: require exact host equality
 * (host+port) REGARDLESS of `sec-fetch-site` — a sibling subdomain like
 * `evil.example.com` → `app.example.com` reads `sec-fetch-site: same-site` yet
 * is a different origin, so trusting same-site would let it through. Only when
 * `Origin` is absent do we fall back to `sec-fetch-site`, accepting ONLY
 * `same-origin` (`same-site`/`cross-site`/`none` reject — without an Origin we
 * cannot verify the exact host).
 *
 * Same-origin fetches from the host page (the sandbox action dispatch and the
 * demo apps all POST from the host origin) carry a matching Origin and pass.
 */
export function isCrossSiteRequest(req: Request): boolean {
  if (req.headers.get("authorization")) return false;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return true; // includes "Origin: null" (sandboxed iframe) — fail closed
    }
    const host = req.headers.get("host") ?? new URL(req.url).host;
    return originHost !== host;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site === null) return false; // no browser provenance at all → non-browser caller
  return site !== "same-origin";
}

export type GuardResult =
  | { ok: true; principal: VendoPrincipal }
  | { ok: false; response: Response };

export async function resolvePrincipal(
  req: Request,
  options: VendoHandlerOptions,
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
  if (env["VENDO_ALLOW_REMOTE"] === "1") {
    return { ok: true, principal: DEFAULT_PRINCIPAL };
  }
  // FAIL CLOSED in production. `next build && next start` sets NODE_ENV to
  // "production"; a real deployment therefore gets NO default principal and
  // MUST configure `principal` (or VENDO_ALLOW_REMOTE=1). This makes the
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

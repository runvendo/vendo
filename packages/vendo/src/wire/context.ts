import {
  VendoError,
  isReservedSubject,
  principalSchema,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { adoptEphemeralSubject, registerEphemeralSubject } from "@vendoai/store";
import { BASE_PATH, hex, type WireDeps } from "./shared.js";

/** The anonymous-session machinery + the one shared per-request context
    resolution pass (kill-list B4): opaque anon cookie mint/read/clear, the
    anonymous→signed-in merge, and RunContext assembly. Every wire area
    resolves context through createContextResolver below. */

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

function randomId(): string {
  const raw = new Uint8Array(16); // 128-bit session id
  globalThis.crypto.getRandomValues(raw);
  return hex(raw);
}

function ephemeralPrincipal(subject: string): Principal {
  return { kind: "user", subject, ephemeral: true };
}

/** 00 overview ("no host principal resolver → an ephemeral session-scoped
    principal"), 01-core §2, 02-store §4. When `principal(req)` returns null the
    visitor is anonymous, and each CLIENT gets its OWN ephemeral principal —
    carried by an opaque httpOnly cookie (a random 128-bit session id) so two
    anonymous visitors never share threads, grants, approvals, or apps. The
    cookie is just a pointer: the session's `vendo_sessions` row and its
    ordinary disk rows are the authority (02-store §4, kill-list B3), so it
    carries no signature — an invented id names its own empty session. */
const ANON_COOKIE = "vendo_anon_session";
/** Secure requests use the `__Host-` prefix against session fixation (cookie
    tossing): a sibling subdomain could otherwise plant an attacker's own
    session cookie via `Domain=` and read everything the victim's anonymous
    session then accrues — browsers refuse `__Host-*` cookies that set Domain or
    arrive from another host. `__Host-` REQUIRES Secure + Path=/ + no Domain. */
const ANON_COOKIE_SECURE = `__Host-${ANON_COOKIE}`;

function anonCookieName(secure: boolean): string {
  return secure ? ANON_COOKIE_SECURE : ANON_COOKIE;
}

/** Whether a request counts as secure for cookie purposes: its own URL is
    https, OR the operator-set VENDO_BASE_URL (the TRUSTED origin channel —
    never x-forwarded-*) is https — i.e. TLS terminates at a proxy and the
    request reaches this process as http. */
function secureRequest(url: URL, trustedBaseIsHttps: boolean): boolean {
  return url.protocol === "https:" || trustedBaseIsHttps;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The shape of the opaque pointer we mint: 128-bit lowercase hex (randomId). */
const ANON_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Read the anonymous-session pointer from the Cookie header; return the id
    when it is a well-formed 128-bit hex pointer, else null (absent or
    malformed → the caller mints a fresh session). There is nothing to verify
    beyond shape: the session's `vendo_sessions` row is the authority, so an
    invented id merely names its own EMPTY session — guessing a live one is a
    2^128 search (kill-list B3; ids survive restarts and cross instances with
    the disk rows). Looks up the name matching the CURRENT request's secure
    determination — a client switching protocols just gets a fresh ephemeral
    session. */
function readAnonCookie(cookieHeader: string | null, secure: boolean): string | null {
  const raw = readCookie(cookieHeader, anonCookieName(secure));
  return raw !== null && ANON_ID_PATTERN.test(raw) ? raw : null;
}

/** The Set-Cookie for a freshly minted anonymous session. Secure requests get
    the fixation-proof `__Host-` form (Secure + Path=/, per the prefix rules);
    insecure (localhost http dev) keeps the plain name scoped to the wire base. */
function buildAnonCookie(id: string, secure: boolean): string {
  return secure
    ? `${ANON_COOKIE_SECURE}=${id}; Path=/; HttpOnly; SameSite=Lax; Secure`
    : `${ANON_COOKIE}=${id}; Path=${BASE_PATH}; HttpOnly; SameSite=Lax`;
}

/** The Set-Cookie that CLEARS the anonymous session (block-actions design §C:
    the first authenticated request carrying a valid anon cookie merges the
    session's data and retires the cookie). Same attributes as buildAnonCookie
    so the browser matches the stored cookie; Max-Age=0 expires it. */
function clearedAnonCookie(secure: boolean): string {
  return secure
    ? `${ANON_COOKIE_SECURE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
    : `${ANON_COOKIE}=; Path=${BASE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Append the minted Set-Cookie to the response. Stream/SSE responses carry
    immutable headers, so re-wrap via `new Response(body, response)` (copies
    status/statusText/headers into a fresh mutable Headers) before appending. */
export function withAnonCookie(response: Response, setCookie: string | undefined): Response {
  if (setCookie === undefined) return response;
  const rewrapped = new Response(response.body, response);
  rewrapped.headers.append("set-cookie", setCookie);
  return rewrapped;
}

/** Per-request anonymous-session state. The wire handler closure is shared
    across requests, so this MUST be minted per-invocation — a shared one would
    leak one visitor's session to the next. INVARIANT: one request resolves to
    at most ONE anonymous id — `id` caches the first resolution so a route that
    resolves context twice on a cookie-less request can never mint a second id
    (which would silently split one request across two subjects and overwrite
    the Set-Cookie). */
export interface AnonSession {
  id?: string;
  setCookie?: string;
}

/** The one context-resolution pass every route shares (kill-list B4): resolve
    the host principal (or mint/read the per-client anonymous session), enforce
    the resolver invariants, run the anonymous→signed-in merge, and touch the
    ephemeral session row. Returned resolver is called per route with a venue. */
export function createContextResolver(
  deps: WireDeps,
  anon: AnonSession,
): (req: Request, venue: RunContext["venue"]) => Promise<RunContext> {
  return async (req, venue) => {
    const resolved = await deps.principal(req);
    let principal: Principal;
    // Host-resolved principals keep the process-wide fallback sessionId; only
    // anonymous requests fall back to their per-client cookie id (below).
    let sessionId = req.headers.get("x-vendo-session-id") ?? deps.sessionId;
    if (resolved === null) {
      const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
      let id = anon.id ?? readAnonCookie(req.headers.get("cookie"), secure);
      if (id === null) {
        id = randomId();
        anon.setCookie = buildAnonCookie(id, secure);
      }
      anon.id = id;
      principal = ephemeralPrincipal(`anonymous_${id}`);
      // 05-guard §2: session/task grants bind to ctx.sessionId. Anonymous
      // sessions bind per CLIENT (the cookie id), not per PROCESS, so one
      // visitor's session grant never authorizes another's calls. The explicit
      // x-vendo-session-id header still wins when the client sets it.
      if (req.headers.get("x-vendo-session-id") === null) sessionId = `anon_${id}`;
    } else {
      const parsed = principalSchema.safeParse(resolved);
      if (!parsed.success) {
        throw new VendoError("validation", "principal resolver returned an invalid principal");
      }
      // Block-actions design §C: host resolvers mint USER principals only —
      // org context is derived from membership, never resolved — and the
      // `vendo:` namespace is reserved for runtime-minted subjects (webhook
      // trigger principals, org subjects). Both rejections are LOUD: a
      // resolver colliding with the reserved namespace could otherwise act
      // as an org or a webhook principal.
      if (parsed.data.kind !== "user") {
        throw new VendoError("validation", "principal resolver must mint kind:\"user\" principals; org context is derived from org membership");
      }
      if (isReservedSubject(parsed.data.subject)) {
        throw new VendoError("validation", "principal resolver produced a reserved subject (the vendo: namespace is runtime-minted only)");
      }
      principal = parsed.data;
      // Anonymous→signed-in auto-merge (block-actions design §C): the FIRST
      // authenticated request still carrying a valid anonymous-session
      // cookie adopts that session's threads/apps/state into the signed-in
      // subject (grants, approvals, and connected accounts deliberately do
      // NOT transfer — consent doesn't change identities), then retires the
      // cookie. Idempotent: a replay finds nothing to merge and just clears
      // the cookie again. A merge failure must never take down the request:
      // the cookie stays, and the next authenticated request retries.
      if (principal.ephemeral !== true) {
        const secure = secureRequest(new URL(req.url), deps.trustedBaseIsHttps);
        const anonId = readAnonCookie(req.headers.get("cookie"), secure);
        if (anonId !== null) {
          try {
            const merged = await adoptEphemeralSubject(deps.store, `anonymous_${anonId}`, principal.subject);
            anon.setCookie = clearedAnonCookie(secure);
            if (merged !== null) {
              await deps.guard.report({
                id: `aud_${globalThis.crypto.randomUUID()}`,
                at: new Date().toISOString(),
                kind: "principal",
                principal,
                venue,
                presence: "present",
                detail: { event: "anon-merge", from: `anonymous_${anonId}`, ...merged },
              });
            }
          } catch (error) {
            console.warn(`[vendo] anonymous-session merge failed; will retry next request: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    // 02-store §4 (kill-list B3): anonymous rows are ordinary disk rows;
    // registering the subject (registration == touch) is what makes the
    // session sweepable and keeps it alive while the visitor is active. One
    // touch covers both anonymous and host-resolved ephemeral principals.
    if (principal.ephemeral === true) {
      await registerEphemeralSubject(deps.store, principal.subject, deps.sessions.now());
    }
    return {
      principal,
      venue,
      presence: "present",
      sessionId,
      requestHeaders: requestHeaders(req),
    };
  };
}

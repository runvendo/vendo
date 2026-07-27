/**
 * Zero-friction demo sessions (DEMO_AUTOLOGIN=1): the proxy locally signs the
 * SAME HS256 access token GoTrue's password grant would issue for the primary
 * seeded user — same secret, same claims shape, same expiry — so a prospect's
 * first page load renders signed-in with no login UI and no Supabase stack.
 * The unchanged verifier (server/session.ts) accepts it like any login token.
 * The only extra is the `demo_autologin` claim (GoTrue never sets it), which
 * gates the "Live demo" chip; credential logins never carry it.
 *
 * Edge-safe (jose + env only): the Next proxy imports this module.
 */
import { decodeJwt, SignJWT } from "jose"
import { cadenceDemoUsers, demoAutologin, supabaseJwtSecret, supabaseUrl } from "./users"

/** GoTrue's default access-token expiry — what a real login's token gets. */
const SESSION_TTL_SECONDS = 3600

let warnedHostMismatch = false

/**
 * A bare authority: hostname labels plus an optional port, nothing else.
 * The Host header is NEVER parsed as a URL — `new URL("http://" + host)`
 * silently accepts `evil.example@demos.vendo.run`, `demos.vendo.run#evil`
 * and `demos.vendo.run/evil`, reinterpreting or discarding everything
 * outside the authority, so a foreign host smuggles the demo host past the
 * comparison. Anything with `@`, `/`, `#`, `?`, whitespace, brackets, an
 * empty label, or a second colon fails here and never mints.
 */
const HOST_AUTHORITY = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" }

/** Strictly validate + normalize an authority for comparison: lowercase
 * hostname, default port for the scheme dropped. Null = reject. */
function normalizeHost(rawHost: string, protocol: string): string | null {
  if (!HOST_AUTHORITY.test(rawHost)) return null
  const [hostname, port] = rawHost.split(":")
  if (!hostname || hostname.split(".").some(label => label.length === 0)) return null
  if (port !== undefined) {
    const numeric = Number(port)
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return null
    if (String(numeric) !== DEFAULT_PORTS[protocol]) return `${hostname.toLowerCase()}:${numeric}`
  }
  return hostname.toLowerCase()
}

/** The one authority an auto-login deployment may serve, normalized: the
 * operator-set public origin (VENDO_BASE_URL — the same origin the cookie
 * policy already trusts). FAIL CLOSED: no configured origin, no loopback
 * exception — local runs must set VENDO_BASE_URL explicitly. */
function configuredDemoOrigin(): { host: string; protocol: string } | null {
  const base = process.env.VENDO_BASE_URL
  if (!base) return null
  let configured: URL
  try {
    configured = new URL(base)
  } catch {
    return null
  }
  const host = normalizeHost(configured.host, configured.protocol)
  return host === null ? null : { host, protocol: configured.protocol }
}

/**
 * The single authority a header carries.
 *   undefined = header absent
 *   null      = AMBIGUOUS, never guess: the runtime surfaced more than one
 *               value (repeated fields, or duplicates joined with ", ").
 *               A smuggled second Host is exactly this shape.
 */
function soleHeaderAuthority(request: Request, name: string): string | null | undefined {
  const values: string[] = []
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === name) values.push(value)
  }
  if (values.length === 0) return undefined
  if (values.length > 1) return null
  // NOT trimmed: whitespace must fail the authority check, not be sanitized.
  const only = values[0]!
  return only.includes(",") ? null : only
}

/**
 * Whether this request may be auto-signed-in. The env flag alone is not
 * enough — that would make a leaked/copied `DEMO_AUTOLOGIN=1` an auth bypass
 * on any reachable deployment. It must ALSO arrive for the configured demo
 * origin (this module only ships in the demo host app; there is no non-demo
 * build of Cadence).
 *
 * Host is the source of truth — it is what the edge routed on, whereas
 * X-Forwarded-Host is caller-settable. When XFH IS present (Railway's edge
 * always sets it) it must AGREE with Host after the same normalization, and
 * both must equal the configured origin. That agreement is defense in depth
 * only: it can make the gate stricter, never looser, and a duplicate Host
 * smuggled past an upstream hop fails it because the value the edge saw and
 * the value we see no longer match.
 *
 * KNOWN RESIDUAL (accepted, measured — see the lane's host-binding-probe.txt):
 * over a real connection Node keeps the FIRST Host field and DISCARDS the
 * rest, so a duplicate is invisible here and we decide on the value we were
 * given. The dangerous version — an upstream hop routing on a different value
 * — is what the XFH agreement above catches. What remains is a parser
 * differential in a hop that also forwards no XFH; unobservable from inside
 * the app. Blast radius is a demo session on a demo host; this gate is
 * defense in depth, not the security boundary of any customer deployment.
 *
 * A refusal logs loudly once and the request falls through to the normal
 * unauthenticated flow.
 */
export function demoAutologinActive(request: Request): boolean {
  if (!demoAutologin()) return false
  const expected = configuredDemoOrigin()
  const host = soleHeaderAuthority(request, "host")
  const forwarded = soleHeaderAuthority(request, "x-forwarded-host")
  const actual = expected && typeof host === "string" ? normalizeHost(host, expected.protocol) : null
  const agrees =
    forwarded === undefined ||
    (typeof forwarded === "string" &&
      expected !== null &&
      normalizeHost(forwarded, expected.protocol) === actual)
  if (expected !== null && actual !== null && actual === expected.host && agrees) return true
  if (!warnedHostMismatch) {
    warnedHostMismatch = true
    console.error(
      `[cadence] DEMO_AUTOLOGIN=1 but the request does not match the configured demo origin ` +
        `(${process.env.VENDO_BASE_URL ?? "VENDO_BASE_URL unset — autologin disabled"}): ` +
        `Host=${host === null ? "<ambiguous>" : JSON.stringify(host ?? null)}, ` +
        `X-Forwarded-Host=${forwarded === null ? "<ambiguous>" : JSON.stringify(forwarded ?? null)} ` +
        `— refusing to auto-mint sessions.`,
    )
  }
  return false
}

/** Same-origin-only returnTo → path; anything foreign collapses to "/".
 * Local copy of vendo/auth.ts's safeReturnTo — that module pulls the full
 * supabase preset, too heavy for the edge proxy. */
export function autologinReturnTo(request: Request): string {
  const url = new URL(request.url)
  const candidate = url.searchParams.get("returnTo")
  if (!candidate) return "/"
  try {
    const target = new URL(candidate, url)
    return target.origin === url.origin ? `${target.pathname}${target.search}${target.hash}` : "/"
  } catch {
    return "/"
  }
}

const AUTOLOGIN_CLAIM = "demo_autologin"

export interface MintedSession {
  token: string
  maxAgeSeconds: number
}

/** Mint the auto-login access token for the primary seeded user. */
export async function mintAutologinToken(): Promise<MintedSession> {
  const user = cadenceDemoUsers()[0]!
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({
    email: user.email,
    role: "authenticated",
    user_metadata: { name: user.display },
    [AUTOLOGIN_CLAIM]: true,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(new URL("/auth/v1", supabaseUrl()).toString())
    .setSubject(user.subject)
    .setAudience("authenticated")
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(new TextEncoder().encode(supabaseJwtSecret()))
  return { token, maxAgeSeconds: SESSION_TTL_SECONDS }
}

/** Whether an (already verified) session token was auto-minted — true only
 * for tokens carrying the autologin claim, never for GoTrue-issued logins.
 * Decode-only on purpose: callers gate UI, verification already happened in
 * resolveCadenceSession on the same token. */
export function isAutologinToken(token: string | undefined): boolean {
  if (!token) return false
  try {
    return decodeJwt(token)[AUTOLOGIN_CLAIM] === true
  } catch {
    return false
  }
}

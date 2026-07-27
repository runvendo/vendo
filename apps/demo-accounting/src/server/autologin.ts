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

/** The hosts an auto-login deployment may serve: the operator-set public
 * origin (VENDO_BASE_URL — the same origin the cookie policy already
 * trusts), or loopback when it is unset (local dev, local prod proofs). */
function isDemoHost(host: string): boolean {
  const base = process.env.VENDO_BASE_URL
  if (base) {
    try {
      return new URL(base).host === host
    } catch {
      return false
    }
  }
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/gu, "")
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

/**
 * Whether this request may be auto-signed-in. The env flag alone is not
 * enough — that would make a leaked/copied `DEMO_AUTOLOGIN=1` an auth bypass
 * on any reachable deployment. It must ALSO arrive for the configured demo
 * origin (this module only ships in the demo host app; there is no non-demo
 * build of Cadence). A mismatch logs loudly once and the request falls
 * through to the normal unauthenticated flow.
 */
export function demoAutologinActive(request: Request): boolean {
  if (!demoAutologin()) return false
  const forwarded = request.headers.get("x-forwarded-host")
  const host = (forwarded ?? request.headers.get("host") ?? new URL(request.url).host)
    .split(",")[0]!
    .trim()
  if (isDemoHost(host)) return true
  if (!warnedHostMismatch) {
    warnedHostMismatch = true
    console.error(
      `[cadence] DEMO_AUTOLOGIN=1 but request host "${host}" is not the configured demo origin ` +
        `(${process.env.VENDO_BASE_URL ?? "no VENDO_BASE_URL; loopback only"}) — refusing to auto-mint sessions.`,
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

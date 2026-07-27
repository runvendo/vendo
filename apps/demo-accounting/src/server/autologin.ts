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
import { cadenceDemoUsers, supabaseJwtSecret, supabaseUrl } from "./users"

/** GoTrue's default access-token expiry — what a real login's token gets. */
const SESSION_TTL_SECONDS = 3600

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

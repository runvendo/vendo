/**
 * Hybrid Supabase session verification (Supabase's documented pattern for
 * projects with JWT signing keys: JWKS for asymmetric tokens, the legacy
 * project secret for symmetric ones).
 *
 * - HS256 tokens verify OFFLINE against the project JWT secret. This is the
 *   away-execution path: `@vendoai/actions/presets` `supabasePreset` mints
 *   user JWTs with the same secret and this verifier — Cadence's own API
 *   wall — accepts them with no Supabase stack running.
 * - ES256 tokens (what `supabase start` ≥ v2.71 signs logins with) verify
 *   against GoTrue's JWKS. Those tokens only exist while the stack is up, so
 *   the JWKS endpoint is reachable exactly when it is needed.
 *
 * Edge-safe (jose + fetch + env only): the Next proxy imports this module.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyResult } from "jose"
import { isSecureDeployment, supabaseJwtSecret, supabaseUrl } from "./users"

/** Supabase's own `sb-<project-ref>-auth-token` cookie shape (ref "cadence"),
 * holding the raw access token — so the shipped `auth: supabase()` preset
 * (src/vendo/server.ts) reads the same session this module verifies. */
export const SESSION_COOKIE = "sb-cadence-auth-token"

export interface CadenceSession {
  /** The Supabase user id (JWT `sub`) — the Vendo principal subject. */
  subject: string
  display: string
  email?: string
}

function cookieToken(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue
    const value = part.slice(separator + 1).trim()
    if (value) return value
  }
  return undefined
}

/** The Supabase access token on a request: `Authorization: Bearer` (present
 * forwarding and actAs-minted away requests) or the login session cookie. */
export function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")
  if (authorization && /^bearer\s/i.test(authorization)) {
    const token = authorization.slice(7).trim()
    if (token) return token
  }
  return cookieToken(request.headers.get("cookie"))
}

const jwksBySource = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function gotrueJwks(): ReturnType<typeof createRemoteJWKSet> {
  const source = new URL("/auth/v1/.well-known/jwks.json", supabaseUrl()).toString()
  let jwks = jwksBySource.get(source)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(source))
    jwksBySource.set(source, jwks)
  }
  return jwks
}

/** Verify the request's Supabase access token — HS256 against the project
 * JWT secret, ES256 against GoTrue's JWKS. The role/audience gate matters:
 * Supabase API keys (anon, service_role) are JWTs signed with the SAME
 * legacy secret and must never count as a signed-in user. */
export async function resolveCadenceSession(request: Request): Promise<CadenceSession | null> {
  const token = sessionToken(request)
  if (!token) return null
  try {
    const alg = decodeProtectedHeader(token).alg
    let verified: JWTVerifyResult
    if (alg === "HS256") {
      verified = await jwtVerify(token, new TextEncoder().encode(supabaseJwtSecret()), {
        algorithms: ["HS256"],
        audience: "authenticated",
      })
    } else if (alg === "ES256") {
      verified = await jwtVerify(token, gotrueJwks(), {
        algorithms: ["ES256"],
        audience: "authenticated",
      })
    } else {
      return null
    }
    const { payload } = verified
    if (payload.role !== "authenticated") return null
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null
    const metadata = payload.user_metadata as { name?: unknown } | null | undefined
    const name = typeof metadata?.name === "string" ? metadata.name : undefined
    const email = typeof payload.email === "string" ? payload.email : undefined
    return { subject: payload.sub, display: name ?? email ?? payload.sub, email }
  } catch {
    return null
  }
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = isSecureDeployment() ? "; Secure" : ""
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; SameSite=Lax${secure}`
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0)
}

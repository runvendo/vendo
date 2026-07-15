import { supabasePreset } from "@vendoai/actions/presets"
import type { ActAs, Principal } from "@vendoai/vendo"
import { resolveCadenceSession } from "@/server/session"
import { resolveCadenceSubject, supabaseJwtSecret } from "@/server/users"

/** Session-backed principal: the Supabase user id is the Vendo subject.
 * Requests without a valid session resolve to null and ride the umbrella's
 * per-client anonymous principal. */
export async function resolveCadencePrincipal(request: Request): Promise<Principal | null> {
  const session = await resolveCadenceSession(request)
  return session ? { kind: "user", subject: session.subject, display: session.display } : null
}

/** The operator-set public origin (VENDO_BASE_URL) or, failing that, the
 * request's own origin. */
export function publicOrigin(request?: Request): URL {
  return new URL(process.env.VENDO_BASE_URL ?? request?.url ?? "http://localhost:3000")
}

/** Same-origin-only returnTo: anything else collapses to "/". */
export function safeReturnTo(candidate: string | null | undefined, base: URL = publicOrigin()): string {
  if (!candidate) return "/"
  try {
    const target = new URL(candidate, base)
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/"
  } catch {
    return "/"
  }
}

export function cadencePublicUrl(request: Request, path: string): URL {
  return new URL(path, publicOrigin(request))
}

/** Away + MCP execution: mint a REAL Supabase access token for the grant's
 * subject with the project's own JWT secret, via the shipped Supabase preset.
 * Subjects Cadence never seeded are declined through the claims resolver
 * (null → the seam surfaces "host declined"). The secret resolves per mint
 * and minted tokens live only inside the preset's in-memory cache — never
 * logged, never persisted. */
export const actAsCadenceUser: ActAs = supabasePreset({
  secret: () => supabaseJwtSecret(),
  claims: (principal) => {
    const user = resolveCadenceSubject(principal.subject)
    return user ? { email: user.email, user_metadata: { name: user.display } } : null
  },
})

import { supabase } from "@vendoai/vendo/auth/supabase"
import { resolveCadenceSubject, supabaseJwtSecret, supabaseUrl } from "@/server/users"

/** One preset fills all three identity seams (09-vendo §2.1): the
 * request→Principal resolver, the away/MCP actAs seam, and the door's OAuth
 * adapter. Sessions verify the same hybrid way `src/server/session.ts` does —
 * HS256 offline against the project JWT secret (also what away execution
 * mints with), ES256 login tokens (`supabase start` ≥ v2.71) against GoTrue's
 * JWKS. `user` maps a Supabase user id to the seeded Cadence identity;
 * returning null means "not a Cadence user" — the principal resolves to
 * anonymous and away/MCP minting for that subject declines. */
export const cadenceAuth = supabase({
  secret: () => supabaseJwtSecret(),
  // Lazy: supabaseUrl() defaults to the `supabase start` stack when
  // SUPABASE_URL is unset, keeping local dev zero-config.
  jwks: () => new URL("/auth/v1/.well-known/jwks.json", supabaseUrl()),
  user: (subject) => {
    const user = resolveCadenceSubject(subject)
    return user ? { display: user.display, email: user.email } : null
  },
})

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

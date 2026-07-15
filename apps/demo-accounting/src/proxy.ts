import { NextResponse, type NextRequest } from "next/server"
import { resolveCadenceSession } from "@/server/session"

/**
 * Cadence requires a real Supabase sign-in (Next 16 proxy, né middleware):
 * pages bounce to /login, firm API routes answer 401 without a valid Supabase
 * access token. This is what makes credential forwarding load-bearing —
 * present execution forwards the signed-in user's session, away execution
 * only works because actAs mints a real Supabase user JWT for the granting
 * user with the project JWT secret.
 *
 * Bypassed surfaces keep their own auth story: the Vendo door (/api/vendo)
 * runs per-client anonymous principals, /login must render signed-out, and
 * the demo simulation endpoints (/api/demo) stay reachable between takes.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/vendo",
  "/.well-known",
  "/api/demo",
]

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next()
  }
  const session = await resolveCadenceSession(request)
  if (session) return NextResponse.next()
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { message: "Sign in to Cadence to use its API", code: "unauthenticated" } },
      { status: 401 },
    )
  }
  const login = new URL("/login", request.nextUrl)
  login.searchParams.set("returnTo", `${pathname}${search}`)
  return NextResponse.redirect(login)
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  matcher: ["/((?!_next/|.*\\..*).*)"],
}

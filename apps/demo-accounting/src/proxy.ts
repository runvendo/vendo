import { NextResponse, type NextRequest } from "next/server"
import { mintAutologinToken } from "@/server/autologin"
import { resolveCadenceSession, SESSION_COOKIE } from "@/server/session"
import { demoAutologin, isSecureDeployment } from "@/server/users"

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
  if (demoAutologin()) {
    // Zero-friction demo mode: locally sign the same HS256 session token a
    // GoTrue login would issue (no Supabase running), inject it into THIS
    // request so the first paint already renders signed-in (no redirect), and
    // Set-Cookie it for the requests that follow. /logout still clears the
    // cookie — under this flag it means "reset my session": the very next
    // request mints a fresh one.
    const minted = await mintAutologinToken()
    const headers = new Headers(request.headers)
    const cookie = headers.get("cookie")
    const pair = `${SESSION_COOKIE}=${minted.token}`
    headers.set("cookie", cookie ? `${cookie}; ${pair}` : pair)
    const response = NextResponse.next({ request: { headers } })
    // Same attributes sessionCookie() (server/session.ts) sets on login.
    response.cookies.set(SESSION_COOKIE, minted.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: isSecureDeployment(),
      maxAge: minted.maxAgeSeconds,
    })
    return response
  }
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

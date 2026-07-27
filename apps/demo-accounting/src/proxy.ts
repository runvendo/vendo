import { NextResponse, type NextRequest } from "next/server"
import { autologinReturnTo, demoAutologinActive, mintAutologinToken } from "@/server/autologin"
import { resolveCadenceSession, SESSION_COOKIE } from "@/server/session"
import { isSecureDeployment } from "@/server/users"

/**
 * Cadence requires a real Supabase sign-in (Next 16 proxy, né middleware):
 * pages bounce to /login, firm API routes answer 401 without a valid Supabase
 * access token. This is what makes credential forwarding load-bearing —
 * present execution forwards the signed-in user's session, away execution
 * only works because actAs mints a real Supabase user JWT for the granting
 * user with the project JWT secret.
 *
 * Bypassed surfaces keep their own auth story: the Vendo door (/api/vendo)
 * runs per-client anonymous principals, /login must render signed-out
 * (except in auto-login mode, which never shows a login form — see below),
 * and the demo simulation endpoints (/api/demo) stay reachable between takes.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/vendo",
  "/.well-known",
  "/api/demo",
]

/** Swap the session cookie in a forwarded Cookie header: drop any existing
 * pair with that name, then append the fresh one. Appending alone is not
 * enough — cookieToken() (server/session.ts) takes the FIRST match, so a
 * stale value would keep winning and the first render would be signed out. */
function replaceCookie(header: string | null, name: string, value: string): string {
  const kept = (header ?? "")
    .split(";")
    .map(pair => pair.trim())
    .filter(pair => {
      if (!pair) return false
      const separator = pair.indexOf("=")
      return (separator === -1 ? pair : pair.slice(0, separator)).trim() !== name
    })
  kept.push(`${name}=${value}`)
  return kept.join("; ")
}

async function setMintedCookie(response: NextResponse): Promise<void> {
  const minted = await mintAutologinToken()
  // Same attributes sessionCookie() (server/session.ts) sets on login.
  response.cookies.set(SESSION_COOKIE, minted.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureDeployment(),
    maxAge: minted.maxAgeSeconds,
  })
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl
  // Host-bound (see demoAutologinActive): the env flag alone never bypasses
  // auth on a foreign host.
  const autologin = demoAutologinActive(request)
  if (autologin && (pathname === "/login" || pathname.startsWith("/login/"))) {
    // Z1: with auto-login active the login form must never render — the
    // /logout continuation lands here, so mint (if needed) and continue
    // straight into the product at the sanitized returnTo.
    const response = NextResponse.redirect(new URL(autologinReturnTo(request), request.nextUrl))
    if (!(await resolveCadenceSession(request))) await setMintedCookie(response)
    return response
  }
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next()
  }
  const session = await resolveCadenceSession(request)
  if (session) return NextResponse.next()
  if (autologin) {
    // Zero-friction demo mode: locally sign the same HS256 session token a
    // GoTrue login would issue (no Supabase running), inject it into THIS
    // request so the first paint already renders signed-in (no redirect), and
    // Set-Cookie it for the requests that follow. /logout still clears the
    // cookie — under this flag it means "reset my session": the continuation
    // re-mints immediately.
    const minted = await mintAutologinToken()
    const headers = new Headers(request.headers)
    headers.set("cookie", replaceCookie(headers.get("cookie"), SESSION_COOKIE, minted.token))
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

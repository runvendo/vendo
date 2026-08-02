import { NextResponse, type NextRequest } from "next/server"
import { withBasePath } from "@/lib/base-path"
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

/**
 * A REDIRECT TO A PATH UNDER THE MOUNT POINT.
 *
 * `pathname` arrives with the mount point already stripped by Next, and Next
 * does not put it back on a URL the app builds — so it goes back on here, or
 * the visitor is bounced to a path nothing serves.
 *
 * THE ORIGIN IS THE REQUEST'S OWN, AND IT IS NOT ALWAYS THE VISITOR'S. Behind
 * the edge that serves this demo in place, the worker proxies to the container
 * with Host dropped (it has to be: `demoAutologinActive` only auto-signs-in a
 * request whose Host is the origin `VENDO_BASE_URL` names, and that is the
 * container's own origin, the one the app's tool calls go to). So every
 * absolute URL reachable in here names Railway. A path-only Location would be
 * the header-trust-free answer and is NOT available: Next's proxy runtime
 * re-parses the header as an absolute URL and throws ERR_INVALID_URL, answering
 * 500 — proven on the real production server, not assumed. Next emits absolute
 * Locations of its own anyway (the trailing-slash 308), so no amount of care in
 * here can make the app the place this is solved.
 *
 * It is solved one hop out instead: the edge worker rewrites a Location that
 * names the origin it proxied to, which is what a reverse proxy is for and
 * covers Next's own redirects as well as these. On a local run and on the bare
 * Railway origin the request's own origin is already the right answer.
 */
function mountedRedirect(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(withBasePath(path), request.nextUrl))
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
    const response = mountedRedirect(request, autologinReturnTo(request))
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
  // `pathname` already has the mount point stripped by Next, so returnTo stays
  // in the app's own vocabulary; the prefix goes back on when a URL is emitted.
  const returnTo = encodeURIComponent(`${pathname}${search}`)
  return mountedRedirect(request, `/login?returnTo=${returnTo}`)
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  //
  // "/" is listed SEPARATELY and is load-bearing under a basePath. Next prefixes
  // every matcher with the mount point, so the catch-all below becomes
  // `/cadence/((?!…).*)` — which needs the slash after `/cadence` and therefore
  // does not match the bare mount root a visitor actually types. Without this
  // entry the dashboard is the ONE page the auth gate never sees, and it renders
  // signed-out visitors a signed-in page. Proven on the real server.
  matcher: ["/", "/((?!_next/|.*\\..*).*)"],
}

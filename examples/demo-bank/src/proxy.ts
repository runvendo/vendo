import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { withBasePath } from "@/lib/base-path";
import { demoAutologinActive, mintAutologinSession } from "@/server/autologin";
import { authSecret, isSecureDeployment } from "@/server/users";
import { publicUrl, safeReturnTo } from "@/vendo/auth";

/**
 * Maple requires a real sign-in (Next 16 proxy, né middleware): pages bounce
 * to /login, bank API routes answer 401 without a valid Auth.js session. This
 * is what makes credential forwarding load-bearing — present execution
 * forwards the signed-in user's cookie, away execution only works because
 * actAs mints a real session for the granting user.
 *
 * Bypassed surfaces keep their own auth story: the Vendo door (/api/vendo,
 * /.well-known) runs MCP OAuth + per-client anonymous principals, /api/auth is
 * Auth.js itself, /login must render signed-out (except in auto-login mode,
 * which never shows a login form — see below), voice and demo-reset keep
 * their local-only gates.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/vendo",
  "/.well-known",
  "/api/voice",
  "/api/demo/reset",
];

/** Swap the session cookie in a forwarded Cookie header: drop any existing
 * pair with that name, then append the fresh one. Appending alone is not
 * enough — cookie parsers take the FIRST match, so a stale value would keep
 * winning and the first render would be signed out. */
function replaceCookie(header: string | null, name: string, value: string): string {
  const kept = (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const separator = pair.indexOf("=");
      return (separator === -1 ? pair : pair.slice(0, separator)).trim() !== name;
    });
  kept.push(`${name}=${value}`);
  return kept.join("; ");
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
  return NextResponse.redirect(new URL(withBasePath(path), request.nextUrl));
}

async function setMintedCookie(response: NextResponse): Promise<void> {
  const session = await mintAutologinSession();
  response.cookies.set(session.name, session.value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureDeployment(),
    maxAge: session.maxAgeSeconds,
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  // Host-bound (see demoAutologinActive): the env flag alone never bypasses
  // auth on a foreign host.
  const autologin = demoAutologinActive(request);
  if (autologin && (pathname === "/login" || pathname.startsWith("/login/"))) {
    // Z1: with auto-login active the login form must never render — a
    // /logout continuation lands here, so mint (if needed) and continue
    // straight into the product at the sanitized returnTo.
    // `continueTo` is already the PUBLIC spelling (safeReturnTo returns the
    // browser's own, /maple included), so it must NOT go back through
    // mountedRedirect — that second prefix is the /maple/maple/… shape.
    const continueTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"), publicUrl(request));
    const response = NextResponse.redirect(new URL(continueTo, request.nextUrl));
    const token = await getToken({
      req: request,
      secret: authSecret(),
      secureCookie: isSecureDeployment(),
    });
    if (typeof token?.sub !== "string") await setMintedCookie(response);
    return response;
  }
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }
  const token = await getToken({
    req: request,
    secret: authSecret(),
    secureCookie: isSecureDeployment(),
  });
  if (typeof token?.sub === "string") return NextResponse.next();
  if (autologin) {
    // Zero-friction demo mode: mint the same Auth.js session cookie a
    // credential login would, inject it into THIS request so the first paint
    // already renders signed-in (no redirect), and Set-Cookie it for the
    // requests that follow. /logout still clears the cookie — under this flag
    // it means "reset my session": the continuation re-mints immediately.
    const session = await mintAutologinSession();
    const headers = new Headers(request.headers);
    headers.set("cookie", replaceCookie(headers.get("cookie"), session.name, session.value));
    const response = NextResponse.next({ request: { headers } });
    response.cookies.set(session.name, session.value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: isSecureDeployment(),
      maxAge: session.maxAgeSeconds,
    });
    return response;
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { message: "Sign in to Maple to use its API", code: "unauthenticated" } },
      { status: 401 },
    );
  }
  // `pathname` arrives with the mount point stripped by Next, but returnTo is
  // handed to the BROWSER and read back by safeReturnTo, which speaks the public
  // spelling. Emitting the stripped path made sign-in land on /accounts — a 404
  // under /maple — on a deployment whose every page rendered fine.
  const returnTo = encodeURIComponent(withBasePath(`${pathname}${search}`));
  return mountedRedirect(request, `/login?returnTo=${returnTo}`);
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  //
  // "/" is listed SEPARATELY and is load-bearing under a basePath. Next prefixes
  // every matcher with the mount point, so the catch-all below becomes
  // `/maple/((?!…).*)` — which needs the slash after `/maple` and therefore does
  // not match the bare mount root a visitor actually types. Without this entry
  // the home page is the ONE page the auth gate never sees, and it renders
  // signed-out visitors a signed-in page. Proven on the real server.
  matcher: ["/", "/((?!_next/|.*\\..*).*)"],
};

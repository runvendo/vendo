import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { mintAutologinSession } from "@/server/autologin";
import { authSecret, demoAutologin, isSecureDeployment } from "@/server/users";

/**
 * Maple requires a real sign-in (Next 16 proxy, né middleware): pages bounce
 * to /login, bank API routes answer 401 without a valid Auth.js session. This
 * is what makes credential forwarding load-bearing — present execution
 * forwards the signed-in user's cookie, away execution only works because
 * actAs mints a real session for the granting user.
 *
 * Bypassed surfaces keep their own auth story: the Vendo door (/api/vendo,
 * /.well-known) runs MCP OAuth + per-client anonymous principals, /api/auth is
 * Auth.js itself, /login must render signed-out, voice and demo-reset keep
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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }
  const token = await getToken({
    req: request,
    secret: authSecret(),
    secureCookie: isSecureDeployment(),
  });
  if (typeof token?.sub === "string") return NextResponse.next();
  if (demoAutologin()) {
    // Zero-friction demo mode: mint the same Auth.js session cookie a
    // credential login would, inject it into THIS request so the first paint
    // already renders signed-in (no redirect), and Set-Cookie it for the
    // requests that follow. /logout still clears the cookie — under this flag
    // it means "reset my session": the very next request mints a fresh one.
    const session = await mintAutologinSession();
    const headers = new Headers(request.headers);
    const cookie = headers.get("cookie");
    const pair = `${session.name}=${session.value}`;
    headers.set("cookie", cookie ? `${cookie}; ${pair}` : pair);
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
  const login = new URL("/login", request.nextUrl);
  login.searchParams.set("returnTo", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  matcher: ["/((?!_next/|.*\\..*).*)"],
};

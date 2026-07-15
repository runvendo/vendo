import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { authSecret, isSecureDeployment } from "@/server/users";

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

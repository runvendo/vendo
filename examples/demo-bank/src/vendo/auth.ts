import { getToken } from "next-auth/jwt";
import {
  authSecret,
  isSecureDeployment,
  resolveMapleSubject,
  type MapleDemoUser,
} from "@/server/users";

/** Read the real Auth.js session (a JWE minted with AUTH_SECRET) off a plain
 * Request and resolve it to a seeded Maple user. Used directly by API routes
 * that need the full seeded user (not just a Vendo Principal) — the
 * principal/actAs/oauth seams themselves are now `authJs()` (./server.ts). */
export async function resolveMapleSession(request: Request): Promise<MapleDemoUser | null> {
  const token = await getToken({
    req: request,
    secret: authSecret(),
    secureCookie: isSecureDeployment(),
  });
  return typeof token?.sub === "string" ? resolveMapleSubject(token.sub) : null;
}

/** The operator-set public origin (VENDO_BASE_URL) or, failing that, the
 * request's own origin — mirrors how the door derives its URLs. */
export function publicOrigin(request?: Request): URL {
  return new URL(process.env.VENDO_BASE_URL ?? request?.url ?? "http://localhost:3000");
}

/** Same-origin-only returnTo: anything else collapses to "/". */
export function safeReturnTo(candidate: string | null | undefined, base: URL = publicOrigin()): string {
  if (!candidate) return "/";
  try {
    const target = new URL(candidate, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function maplePublicUrl(request: Request, path: string): URL {
  return new URL(path, publicOrigin(request));
}

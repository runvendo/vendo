import { joinUrl, withPathPrefix } from "@vendoai/core";
import { getToken } from "next-auth/jwt";
import { withBasePath } from "@/lib/base-path";
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

/** The operator-set FULL public URL (VENDO_BASE_URL — /maple included) or,
 * failing that, the request's own origin under Maple's mount point — mirrors how
 * the door and the auth presets derive their URLs. The request contributes its
 * ORIGIN only: its path is wherever the visitor happens to be, not where the app
 * is mounted, and letting it through made every URL built from here hang off the
 * current page. */
export function publicUrl(request?: Request): URL {
  return new URL(process.env.VENDO_BASE_URL ?? withBasePath("/"), request?.url ?? "http://localhost:3000");
}

/** Same-origin-only returnTo: anything else collapses to the app's own home. The
 * returned path is the PUBLIC spelling — prefix included, exactly as the browser
 * will use it. #867: callers used to run it back through withBasePath() and
 * produce /maple/maple/…. The fallback is the base's own path, not "/": under a
 * mount point the origin root serves nothing, so "/" is a 404. */
export function safeReturnTo(candidate: string | null | undefined, base: URL = publicUrl()): string {
  const home = base.pathname.replace(/\/+$/u, "") || "/";
  if (!candidate) return home;
  try {
    const target = new URL(candidate, base);
    if (target.origin !== base.origin) return home;
    // Belt and braces: a returnTo that arrives in the app's mount-STRIPPED
    // vocabulary — an old bookmark, a link built before the prefix existed —
    // still lands somewhere that exists. The prefix comes from the deployment's
    // own base URL, and withPathPrefix is idempotent, so an already-public path
    // is left exactly as it is.
    return withPathPrefix(home === "/" ? "" : home, `${target.pathname}${target.search}${target.hash}`);
  } catch {
    return home;
  }
}

export function maplePublicUrl(request: Request, path: string): URL {
  return joinUrl(publicUrl(request), path);
}

import type { authJs } from "@vendoai/vendo/auth/auth-js";
import { getToken } from "next-auth/jwt";
import { stripBasePath, withBasePath } from "@/lib/base-path";
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

/** Same-origin-only returnTo, in the APP's own vocabulary — the mount point
 * comes off here and every caller puts it back with `withBasePath`. Anything
 * not same-origin collapses to "/". */
export function safeReturnTo(candidate: string | null | undefined, base: URL = publicOrigin()): string {
  if (!candidate) return "/";
  try {
    const target = new URL(candidate, base);
    return target.origin === base.origin
      ? `${stripBasePath(target.pathname)}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function maplePublicUrl(request: Request, path: string): URL {
  return new URL(path, publicOrigin(request));
}

/**
 * THE DOOR'S SIGN-IN BOUNCE, UNDER THE MOUNT POINT.
 *
 * A sessionless MCP client is redirected to the host's login page, and that is
 * the ONE page a real client's human ever sees. The auth preset builds it as
 * `<public origin>/login` — it has no way to know Maple is served in place
 * under BASE_PATH — so the Location it emits 404s. Same job as
 * `mountedRedirect` in src/proxy.ts: Next puts the prefix back on nothing the
 * app builds itself, and a redirect's Location is the app's own URL.
 */
export function withMountedLogin(preset: ReturnType<typeof authJs>): ReturnType<typeof authJs> {
  const oauth = preset.oauth;
  if (oauth?.session === undefined) return preset;
  const bounce = oauth.session;
  return {
    ...preset,
    oauth: {
      ...oauth,
      session: async (request, context) => {
        const answer = await bounce(request, context);
        // The only Response this seam returns is that login redirect.
        if (!(answer instanceof Response)) return answer;
        const login = new URL(answer.headers.get("location")!);
        login.pathname = withBasePath(login.pathname);
        return Response.redirect(login, answer.status);
      },
    },
  };
}

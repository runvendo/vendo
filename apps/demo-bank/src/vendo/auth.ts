import { authJsPreset } from "@vendoai/actions/presets";
import type { ActAs, Principal } from "@vendoai/vendo";
import { getToken } from "next-auth/jwt";
import {
  authSecret,
  isSecureDeployment,
  resolveMapleSubject,
  type MapleDemoUser,
} from "@/server/users";

/** Read the real Auth.js session (a JWE minted with AUTH_SECRET) off a plain
 * Request and resolve it to a seeded Maple user. */
export async function resolveMapleSession(request: Request): Promise<MapleDemoUser | null> {
  const token = await getToken({
    req: request,
    secret: authSecret(),
    secureCookie: isSecureDeployment(),
  });
  return typeof token?.sub === "string" ? resolveMapleSubject(token.sub) : null;
}

/** Session-backed principal: the Auth.js user id is the Vendo subject. */
export async function resolveMaplePrincipal(request: Request): Promise<Principal | null> {
  const user = await resolveMapleSession(request);
  return user ? { kind: "user", subject: user.subject, display: user.display } : null;
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

/** Away + MCP execution: mint a REAL Auth.js session for the grant's subject
 * with the host's own AUTH_SECRET, via the shipped Auth.js preset. Subjects
 * Maple never issued are declined through the claims resolver (null → the
 * seam surfaces "host declined"). The secret resolves per-mint and minted
 * tokens live only inside the preset's in-memory cache — never logged, never
 * persisted. */
export const actAsMapleUser: ActAs = authJsPreset({
  secret: () => authSecret(),
  secureCookie: isSecureDeployment(),
  claims: (principal) => {
    const user = resolveMapleSubject(principal.subject);
    return user ? { name: user.display, email: user.email } : null;
  },
});

import { encode, getToken } from "next-auth/jwt";
import { authSecret, isSecureDeployment, primaryMapleUser } from "./users";

/**
 * Zero-friction demo sessions (DEMO_AUTOLOGIN=1): the proxy mints the SAME
 * Auth.js JWE a credential login would — same secret, same cookie name/salt,
 * same default lifetime — for the primary seeded user, so a prospect's first
 * page load renders signed-in with no login UI. The only difference is the
 * `demoAutologin` claim, which gates the "Live demo" chip; credential logins
 * never carry it.
 *
 * Edge-safe (next-auth/jwt is jose over Web Crypto): the Next proxy imports
 * this module.
 */

/** Auth.js' own default session maxAge — credential logins get the same. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

let warnedHostMismatch = false;

/** The hosts an auto-login deployment may serve: the operator-set public
 * origin (VENDO_BASE_URL — the same origin the cookie policy and the door
 * already trust), or loopback when it is unset (local dev, local prod
 * proofs). Anything else is a foreign host. */
function isDemoHost(host: string): boolean {
  const base = process.env.VENDO_BASE_URL;
  if (base) {
    try {
      return new URL(base).host === host;
    } catch {
      return false;
    }
  }
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/gu, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Whether this request may be auto-signed-in. The env flag alone is not
 * enough — that would make a leaked/copied `DEMO_AUTOLOGIN=1` an auth bypass
 * on any reachable deployment. It must ALSO arrive for the configured demo
 * origin (this module only ships in the demo host app; there is no non-demo
 * build of Maple). A mismatch logs loudly once and the request falls through
 * to the normal unauthenticated flow.
 */
export function demoAutologinActive(request: Request): boolean {
  if (process.env.DEMO_AUTOLOGIN !== "1") return false;
  const forwarded = request.headers.get("x-forwarded-host");
  const host = (forwarded ?? request.headers.get("host") ?? new URL(request.url).host)
    .split(",")[0]!
    .trim();
  if (isDemoHost(host)) return true;
  if (!warnedHostMismatch) {
    warnedHostMismatch = true;
    console.error(
      `[maple] DEMO_AUTOLOGIN=1 but request host "${host}" is not the configured demo origin ` +
        `(${process.env.VENDO_BASE_URL ?? "no VENDO_BASE_URL; loopback only"}) — refusing to auto-mint sessions.`,
    );
  }
  return false;
}

/** The Auth.js session cookie name — also the JWE key-derivation salt, so it
 * must match what `getToken({ secureCookie })` derives on the read side. */
export function sessionCookieName(): string {
  return isSecureDeployment() ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export interface MintedSession {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

/** Mint the auto-login session cookie for the primary seeded user. */
export async function mintAutologinSession(): Promise<MintedSession> {
  const user = primaryMapleUser();
  const name = sessionCookieName();
  const value = await encode({
    token: {
      sub: user.subject,
      name: user.display,
      email: user.email,
      demoAutologin: true,
    },
    secret: authSecret(),
    salt: name,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return { name, value, maxAgeSeconds: SESSION_MAX_AGE_SECONDS };
}

/** Whether the request's (already valid) session was auto-minted — true only
 * for tokens carrying the `demoAutologin` claim, never for credential logins. */
export async function isAutologinSession(request: Request): Promise<boolean> {
  const token = await getToken({
    req: request,
    secret: authSecret(),
    secureCookie: isSecureDeployment(),
  });
  return token?.demoAutologin === true;
}

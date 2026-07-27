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

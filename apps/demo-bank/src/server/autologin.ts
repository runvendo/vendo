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

/**
 * A bare authority: hostname labels plus an optional port, nothing else.
 * The Host header is NEVER parsed as a URL — `new URL("http://" + host)`
 * silently accepts `evil.example@demos.vendo.run`, `demos.vendo.run#evil`
 * and `demos.vendo.run/evil`, reinterpreting or discarding everything
 * outside the authority, so a foreign host smuggles the demo host past the
 * comparison. Anything with `@`, `/`, `#`, `?`, whitespace, brackets, an
 * empty label, or a second colon fails here and never mints.
 */
const HOST_AUTHORITY = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** Strictly validate + normalize an authority for comparison: lowercase
 * hostname, default port for the scheme dropped. Null = reject. */
function normalizeHost(rawHost: string, protocol: string): string | null {
  if (!HOST_AUTHORITY.test(rawHost)) return null;
  const [hostname, port] = rawHost.split(":");
  if (!hostname || hostname.split(".").some((label) => label.length === 0)) return null;
  if (port !== undefined) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return null;
    if (String(numeric) !== DEFAULT_PORTS[protocol]) return `${hostname.toLowerCase()}:${numeric}`;
  }
  return hostname.toLowerCase();
}

/** The one host an auto-login deployment may serve: the operator-set public
 * origin (VENDO_BASE_URL — the same origin the cookie policy and the door
 * already trust). FAIL CLOSED: no configured origin, no valid bare
 * authority, no loopback exception — local runs must set VENDO_BASE_URL
 * explicitly. Both sides are normalized the SAME strict way. */
function isDemoHost(rawHost: string): boolean {
  const base = process.env.VENDO_BASE_URL;
  if (!base || !rawHost) return false;
  let configured: URL;
  try {
    configured = new URL(base);
  } catch {
    return false;
  }
  const expected = normalizeHost(configured.host, configured.protocol);
  const actual = normalizeHost(rawHost, configured.protocol);
  return expected !== null && actual !== null && expected === actual;
}

/**
 * Whether this request may be auto-signed-in. The env flag alone is not
 * enough — that would make a leaked/copied `DEMO_AUTOLOGIN=1` an auth bypass
 * on any reachable deployment. It must ALSO arrive for the configured demo
 * origin (this module only ships in the demo host app; there is no non-demo
 * build of Maple). The decision reads the Host header ONLY — Railway passes
 * the real public host in Host, while X-Forwarded-Host is attacker-settable
 * and request.url is derived — and a missing Host never mints. A mismatch
 * logs loudly once and the request falls through to the normal
 * unauthenticated flow.
 */
export function demoAutologinActive(request: Request): boolean {
  if (process.env.DEMO_AUTOLOGIN !== "1") return false;
  // NOT trimmed: whitespace must fail the authority check, not be sanitized.
  const host = request.headers.get("host") ?? "";
  if (isDemoHost(host)) return true;
  if (!warnedHostMismatch) {
    warnedHostMismatch = true;
    console.error(
      `[maple] DEMO_AUTOLOGIN=1 but request Host "${host}" is not the configured demo origin ` +
        `(${process.env.VENDO_BASE_URL ?? "VENDO_BASE_URL unset — autologin disabled"}) — refusing to auto-mint sessions.`,
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

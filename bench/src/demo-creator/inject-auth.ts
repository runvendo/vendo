import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Demo-login injection — `demo:create` writes a lightweight auth wall into
 * every clone (criterion 37: the final gate LOGS IN, so the demo must have a
 * login). The template itself deliberately ships anonymous (its README calls
 * that out) and is pinned AS-IS, so the wall lives in generated files only:
 * a Next middleware that gates PAGE routes behind a cookie, and a /login
 * route (demo-bank's pattern: one route.ts serving the GET form + the POST)
 * matching the capture harness's contract (`form[action="/login"]`,
 * `input[name="password"]`). Agent/API surfaces (/api/*, /demo-status) stay
 * open — the guard wrapper route is the cost control there, and the panel's
 * client calls ride the visitor's cookie anyway.
 *
 * Password: DEMO_PASSWORD env on the deployment, else the deterministic
 * seeded fallback `<id>-demo` (same knob pattern as demo-bank/cadence).
 */

/** The demo's password: env DEMO_PASSWORD overrides the seeded `<id>-demo`. */
export function demoPassword(id: string, env: NodeJS.ProcessEnv = {}): string {
  const fromEnv = env.DEMO_PASSWORD;
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : `${id}-demo`;
}

export const DEMO_AUTH_COOKIE = "vendo_demo_auth";

/**
 * The host-bound auto-login gate, ported from the proven
 * `apps/demo-bank/src/server/autologin.ts`. Semantics are copied, not
 * loosened — Maple mints an Auth.js JWE where a clone only needs its cookie,
 * but the DECISION of whether to mint is identical:
 *
 *  - the Host header is validated as a BARE AUTHORITY by regex BEFORE any
 *    parsing, because `new URL("http://" + host)` silently accepts
 *    `victim.example@demo.host`, `demo.host#victim`, `demo.host/victim` and
 *    `demo.host?victim`, reinterpreting or discarding everything outside the
 *    authority — a foreign host would smuggle the demo host past the compare;
 *  - X-Forwarded-Host must AGREE with Host when present (Railway's edge always
 *    sets it) — defense in depth that can only make the gate stricter;
 *  - observable ambiguity (repeated header fields, or duplicates the runtime
 *    joined with ", ") is REFUSED, never guessed;
 *  - it FAILS CLOSED with no configured origin — no loopback exception.
 *
 * Kept as source text (not an import) so the generated middleware stays a
 * single self-contained edge module; the bench test evaluates THIS string, so
 * what is tested is exactly what ships.
 *
 * `process.env.X` is referenced statically so the edge runtime resolves it;
 * `envOverride` exists for the test.
 */
export const AUTOLOGIN_GATE_SOURCE = `/** A bare authority: hostname labels plus an optional port, nothing else. */
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
    if (String(numeric) !== DEFAULT_PORTS[protocol]) return hostname.toLowerCase() + ":" + numeric;
  }
  return hostname.toLowerCase();
}

/** The one authority an auto-login deployment may serve. FAIL CLOSED: no
 * configured origin, no loopback exception. */
function configuredDemoOrigin(baseUrl: string | undefined): { host: string; protocol: string } | null {
  if (!baseUrl) return null;
  let configured: URL;
  try {
    configured = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = normalizeHost(configured.host, configured.protocol);
  return host === null ? null : { host, protocol: configured.protocol };
}

/** The single authority a header carries.
 *   undefined = absent · null = AMBIGUOUS (repeated fields, or joined with ", ") */
function soleHeaderAuthority(request: { headers: Headers }, name: string): string | null | undefined {
  const values: string[] = [];
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === name) values.push(value);
  }
  if (values.length === 0) return undefined;
  if (values.length > 1) return null;
  // NOT trimmed: whitespace must fail the authority check, not be sanitized.
  const only = values[0] as string;
  return only.includes(",") ? null : only;
}

let warnedHostMismatch = false;

/** Whether this request may be auto-signed-in. The env flag alone is not
 * enough — that would make a leaked DEMO_AUTOLOGIN=1 an auth bypass on any
 * reachable deployment. It must ALSO arrive for the configured demo origin. */
function demoAutologinActive(request: { headers: Headers }, envOverride?: Record<string, string | undefined>): boolean {
  const env = envOverride ?? {
    DEMO_AUTOLOGIN: process.env.DEMO_AUTOLOGIN,
    VENDO_BASE_URL: process.env.VENDO_BASE_URL,
  };
  if (env.DEMO_AUTOLOGIN !== "1") return false;
  const expected = configuredDemoOrigin(env.VENDO_BASE_URL);
  const host = soleHeaderAuthority(request, "host");
  const forwarded = soleHeaderAuthority(request, "x-forwarded-host");
  const actual = expected && typeof host === "string" ? normalizeHost(host, expected.protocol) : null;
  const agrees =
    forwarded === undefined ||
    (typeof forwarded === "string" &&
      expected !== null &&
      normalizeHost(forwarded, expected.protocol) === actual);
  if (expected !== null && actual !== null && actual === expected.host && agrees) return true;
  if (!warnedHostMismatch) {
    warnedHostMismatch = true;
    console.error(
      "[demo] DEMO_AUTOLOGIN=1 but the request does not match the configured demo origin (" +
        (env.VENDO_BASE_URL ?? "VENDO_BASE_URL unset — autologin disabled") +
        "): Host=" + (host === null ? "<ambiguous>" : JSON.stringify(host ?? null)) +
        ", X-Forwarded-Host=" + (forwarded === null ? "<ambiguous>" : JSON.stringify(forwarded ?? null)) +
        " — refusing to auto-sign-in.",
    );
  }
  return false;
}`;

const banner = `// ============================================================================
// PLUMBING — demo login wall, written by demo:create (bench/src/demo-creator/
// inject-auth.ts). DO NOT REWRITE PER PROSPECT: the form contract (action=
// "/login", name="password") is what the capture harness and the final gate
// drive; the middleware is what makes "login works" true on the deployed demo.
// ============================================================================`;

export function renderMiddleware(): string {
  return `${banner}
import { NextResponse, type NextRequest } from "next/server";

const OPEN_PREFIXES = ["/api/", "/demo-status", "/login", "/_next/", "/brand/", "/favicon"];

${AUTOLOGIN_GATE_SOURCE}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (request.cookies.get("${DEMO_AUTH_COOKIE}")?.value === "ok") {
    return NextResponse.next();
  }
  // Zero-friction demos: on the configured demo origin the visitor is signed
  // in before first paint — no password wall. /login stays reachable for
  // anyone who wants it, and every other origin still bounces there.
  if (demoAutologinActive(request)) {
    const response = NextResponse.next();
    response.cookies.set("${DEMO_AUTH_COOKIE}", "ok", { httpOnly: true, sameSite: "lax", path: "/" });
    return response;
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
`;
}

/** One route.ts serves the GET form and the POST (demo-bank's /login shape —
 * a page.tsx would conflict with the handler in the same segment). */
export function renderLoginRoute(options: { id: string; prospect: string }): string {
  const prospect = options.prospect.replace(/[`\\$]/g, "");
  return `${banner}
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DEMO_PASSWORD env overrides the seeded fallback (same knob pattern as the
// first-party demo hosts).
const PASSWORD = process.env.DEMO_PASSWORD || "${options.id}-demo";

function loginPage(error?: string): Response {
  const html = \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${prospect} demo — sign in</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #111; background: #fbfbfa; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 24rem); padding: 28px; border: 1px solid #e2e1de; border-radius: 14px; background: #fff; }
    h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -.02em; }
    p { margin: 0 0 18px; color: #77736d; font-size: 14px; line-height: 1.5; }
    input { width: 100%; box-sizing: border-box; min-height: 42px; border: 1px solid #dfddd8; border-radius: 10px; padding: 10px 12px; font: inherit; }
    button { width: 100%; min-height: 44px; margin-top: 14px; border: 0; border-radius: 10px; color: #fff; background: #111; font: 600 14px/1 inherit; cursor: pointer; }
    .error { margin: 0 0 12px; padding: 9px 12px; border-radius: 9px; color: #8c241b; background: #fbedeb; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>${prospect} demo</h1>
    <p>Enter the demo password you were given.</p>
    \${error ? \`<div class="error" role="alert">\${error}</div>\` : ""}
    <form method="post" action="/login">
      <input name="password" type="password" autocomplete="current-password" placeholder="Demo password" required autofocus>
      <button type="submit">Enter demo</button>
    </form>
  </main>
</body>
</html>\`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  return loginPage(error === null ? undefined : "Wrong password — try again.");
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  if (form.get("password") !== PASSWORD) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }
  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set("${DEMO_AUTH_COOKIE}", "ok", { httpOnly: true, sameSite: "lax", path: "/" });
  return response;
}
`;
}

/** App-relative files the injection writes (also added to the rewrite fence). */
export const injectedAuthFiles = [
  "middleware.ts",
  "src/app/login/route.ts",
] as const;

export async function injectDemoAuth(appDir: string, options: { id: string; prospect: string }): Promise<void> {
  await mkdir(path.join(appDir, "src", "app", "login"), { recursive: true });
  await writeFile(path.join(appDir, "middleware.ts"), renderMiddleware());
  await writeFile(path.join(appDir, "src", "app", "login", "route.ts"), renderLoginRoute(options));
}

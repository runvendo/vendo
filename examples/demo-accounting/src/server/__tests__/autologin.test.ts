import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { config, proxy } from "../../proxy"
import { isAutologinToken, mintAutologinToken } from "../autologin"
import { resolveCadenceSession, SESSION_COOKIE } from "../session"
import { cadenceDemoUsers, supabaseAnonKey, supabaseJwtSecret, supabaseUrl } from "../users"

afterEach(() => vi.unstubAllEnvs())

const MAYA = cadenceDemoUsers()[0]!

function requestFor(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    headers: { host: "localhost:3100", ...(cookie ? { cookie } : {}) },
  })
}

/** The autologin gate fails closed without a configured origin, so every
 * minting scenario stubs the demo origin explicitly (like local runs must). */
function stubDemoDeployment(): void {
  vi.stubEnv("DEMO_AUTOLOGIN", "1")
  vi.stubEnv("VENDO_BASE_URL", "http://localhost:3100")
}

/**
 * The redirect target as path+query, asserted to stay on the request's OWN
 * origin and under the mount point.
 *
 * Cadence is served in place at demos.vendo.run/cadence, so a bounce to a path
 * missing the `/cadence` prefix lands on nothing. The origin cannot be fixed
 * here — Next's proxy runtime rejects a relative Location and emits absolute
 * ones itself — so it is rewritten at the edge; what this pins is that the
 * proxy never *introduces* a foreign origin of its own.
 */
function locationOf(response: Response, request: NextRequest): string {
  const location = new URL(response.headers.get("location")!)
  expect(location.origin).toBe(request.nextUrl.origin)
  expect(location.pathname, "every redirect stays under the mount point").toMatch(/^\/cadence(?:\/|$)/u)
  return `${location.pathname}${location.search}`
}

describe("proxy matcher", () => {
  /** Next prefixes every matcher with the mount point, so the catch-all becomes
   *  `/cadence/((?!…).*)` and does not match the bare `/cadence` a visitor
   *  types. Dropping the explicit "/" leaves the dashboard as the one page the
   *  gate never sees — and it renders a signed-out visitor a signed-in page. */
  it("covers the bare mount root, not just paths under it", () => {
    expect(config.matcher).toContain("/")
  })
})

describe("auto-login token minting", () => {
  it("round-trips the UNCHANGED session verifier as the primary seeded user", async () => {
    const minted = await mintAutologinToken()
    await expect(
      resolveCadenceSession(
        new Request("http://cadence.internal/", {
          headers: { cookie: `${SESSION_COOKIE}=${minted.token}` },
        }),
      ),
    ).resolves.toEqual({ subject: MAYA.subject, display: MAYA.display, email: MAYA.email })
    expect(minted.maxAgeSeconds).toBe(3600)
  })

  it("flags only auto-minted tokens — a GoTrue-shaped login token has no claim", async () => {
    const minted = await mintAutologinToken()
    expect(isAutologinToken(minted.token)).toBe(true)

    // What a real GoTrue password grant issues: same secret/claims, no marker.
    const now = Math.floor(Date.now() / 1000)
    const login = await new SignJWT({ email: MAYA.email, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(MAYA.subject)
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(supabaseJwtSecret()))
    expect(isAutologinToken(login)).toBe(false)
    expect(isAutologinToken(undefined)).toBe(false)
    expect(isAutologinToken("not-a-jwt")).toBe(false)
  })
})

describe("production env assertions stay hard without the flag", () => {
  it("throws for missing SUPABASE_JWT_SECRET / SUPABASE_ANON_KEY exactly as before", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => supabaseJwtSecret()).toThrow("SUPABASE_JWT_SECRET is required in production")
    expect(() => supabaseAnonKey()).toThrow("SUPABASE_ANON_KEY is required in production")
  })

  it("with DEMO_AUTOLOGIN=1 the GoTrue env is not required (no Supabase dependency)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("SUPABASE_JWT_SECRET", "operator-secret-with-at-least-32-characters!")
    // What auto-login drops: the GoTrue endpoint and its anon key.
    expect(supabaseAnonKey().split(".")).toHaveLength(3)
    expect(supabaseUrl()).toBe("http://127.0.0.1:54321")
  })

  it("NEVER falls back to the published development signing secret in production, flag or not", () => {
    // The verifier trusts any HS256 token signed with this secret, and the
    // development default is public in this repo — falling back to it on a
    // deployment would let anyone forge an authenticated seeded-user session,
    // host gate or not. Auto-login drops GoTrue, never the signing key.
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    expect(() => supabaseJwtSecret()).toThrow("SUPABASE_JWT_SECRET is required in production")
  })

  it("an explicitly configured secret still wins under the flag", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("SUPABASE_JWT_SECRET", "operator-secret-with-at-least-32-characters!")
    expect(supabaseJwtSecret()).toBe("operator-secret-with-at-least-32-characters!")
  })
})

describe("proxy auto-login behavior", () => {
  it("with DEMO_AUTOLOGIN=1 an unauthenticated page request is signed in before first paint", async () => {
    stubDemoDeployment()
    const response = await proxy(requestFor("/clients"))
    // Not a redirect: the request itself proceeds, carrying the minted cookie.
    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-request-cookie")).toContain(`${SESSION_COOKIE}=`)
    const setCookie = response.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    // The minted cookie is a real session for the unchanged verifier.
    const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!
    await expect(
      resolveCadenceSession(
        new Request("http://cadence.internal/", {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        }),
      ),
    ).resolves.toMatchObject({ subject: MAYA.subject })
  })

  it("the real /logout continuation lands signed-in: /login redirects into the product with a fresh session", async () => {
    stubDemoDeployment()
    // /logout clears the cookie and 303s to /login — with the flag that
    // continuation must never show a login form.
    const request = requestFor("/login")
    const response = await proxy(request)
    expect(response.status).toBe(307)
    expect(locationOf(response, request)).toBe("/cadence/")
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`)
  })

  it("/login honors a same-origin returnTo and collapses foreign ones", async () => {
    stubDemoDeployment()
    const sameRequest = requestFor("/login?returnTo=%2Fclients%3Fq%3Dblue")
    const same = await proxy(sameRequest)
    expect(locationOf(same, sameRequest)).toBe("/cadence/clients?q=blue")
    const foreignRequest = requestFor(`/login?returnTo=${encodeURIComponent("https://evil.example/phish")}`)
    const foreign = await proxy(foreignRequest)
    expect(locationOf(foreign, foreignRequest)).toBe("/cadence/")
  })

  it("without the flag, /login still renders the form (passes through untouched)", async () => {
    const response = await proxy(requestFor("/login"))
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("host binding: a foreign Host never mints, even with X-Forwarded-Host spoofing the demo origin", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    const spoofed = new NextRequest("https://demos.vendo.run/clients", {
      headers: { host: "books.victim.example", "x-forwarded-host": "demos.vendo.run" },
    })
    const response = await proxy(spoofed)
    // Normal unauthenticated flow: bounce to /login, nothing minted.
    expect(response.status).toBe(307)
    expect(locationOf(response, spoofed)).toBe("/cadence/login?returnTo=%2Fclients")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("host binding: a missing Host header never mints", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    const hostless = new NextRequest("https://demos.vendo.run/clients")
    const response = await proxy(hostless)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("fails closed: no VENDO_BASE_URL means no minting, not even for loopback", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    const loopback = new NextRequest("http://127.0.0.1:3100/clients", {
      headers: { host: "127.0.0.1:3100" },
    })
    const response = await proxy(loopback)
    expect(response.status).toBe(307)
    expect(locationOf(response, loopback)).toBe("/cadence/login?returnTo=%2Fclients")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("host binding: the configured demo origin (VENDO_BASE_URL) does mint", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    const demo = new NextRequest("https://demos.vendo.run/clients", {
      headers: { host: "demos.vendo.run" },
    })
    const response = await proxy(demo)
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`)
  })

  it("rejects malformed authorities that a URL parser would smuggle the demo host through", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "http://127.0.0.1:4301")
    const smuggled = [
      "victim.example@127.0.0.1:4301", // userinfo — URL.host would be the demo host
      "127.0.0.1:4301#victim.example", // fragment — discarded by a URL parser
      "127.0.0.1:4301/victim.example", // path — discarded by a URL parser
      "127.0.0.1:4301?victim.example", // query — discarded by a URL parser
      // Leading/trailing whitespace never reaches the gate: the Fetch
      // Headers layer strips optional whitespace (RFC 9110) on the way in,
      // so the app only ever sees the bare value. Embedded whitespace
      // survives, and the authority check rejects it:
      "127.0.0.1:4301\tx",
      "127.0.0.1 4301",
      "[127.0.0.1]:4301", // brackets
      "127.0.0.1:4301:4301", // double colon
      "127..0.0.1:4301", // empty label
      ".127.0.0.1:4301", // leading dot ⇒ empty label
      "127.0.0.1:4301@victim.example", // demo host in the userinfo position
    ]
    for (const host of smuggled) {
      const response = await proxy(
        new NextRequest("http://127.0.0.1:4301/clients", { headers: { host } }),
      )
      expect(response.headers.get("set-cookie"), `Host: ${JSON.stringify(host)}`).toBeNull()
    }
  })

  it("rejects an ambiguous Host: duplicate fields the runtime collapses into one value", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    // Two Host fields: undici joins them, and the joined value is exactly
    // what a smuggled duplicate looks like. Never guess which one routed.
    const duplicate = new NextRequest("https://demos.vendo.run/clients", {
      headers: new Headers([
        ["host", "demos.vendo.run"],
        ["host", "victim.example"],
      ]),
    })
    expect(duplicate.headers.get("host")).toContain(",") // the collapse we must catch
    const response = await proxy(duplicate)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("requires X-Forwarded-Host to agree with Host when the edge sets it", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")

    // Agreement (what Railway's edge actually sends) ⇒ mints.
    const agreeing = await proxy(
      new NextRequest("https://demos.vendo.run/clients", {
        headers: { host: "demos.vendo.run", "x-forwarded-host": "DEMOS.VENDO.RUN:443" },
      }),
    )
    expect(agreeing.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`)

    // Disagreement ⇒ no mint, even though Host alone is the demo origin.
    const disagreeing = await proxy(
      new NextRequest("https://demos.vendo.run/clients", {
        headers: { host: "demos.vendo.run", "x-forwarded-host": "victim.example" },
      }),
    )
    expect(disagreeing.headers.get("set-cookie")).toBeNull()

    // Ambiguous XFH ⇒ no mint.
    const ambiguous = await proxy(
      new NextRequest("https://demos.vendo.run/clients", {
        headers: new Headers([
          ["host", "demos.vendo.run"],
          ["x-forwarded-host", "demos.vendo.run"],
          ["x-forwarded-host", "victim.example"],
        ]),
      }),
    )
    expect(ambiguous.headers.get("set-cookie")).toBeNull()
  })

  it("host comparison is normalized: case-insensitive hostname and default-port equivalence", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    for (const host of ["DEMOS.VENDO.RUN", "demos.vendo.run:443", "Demos.Vendo.Run:443"]) {
      const response = await proxy(
        new NextRequest("https://demos.vendo.run/clients", { headers: { host } }),
      )
      expect(response.headers.get("set-cookie"), `Host: ${host}`).toContain(`${SESSION_COOKIE}=`)
    }
    // A NON-default port is a different host.
    const wrongPort = await proxy(
      new NextRequest("https://demos.vendo.run/clients", { headers: { host: "demos.vendo.run:8443" } }),
    )
    expect(wrongPort.headers.get("set-cookie")).toBeNull()
  })

  it("without the flag, unauthenticated behavior is unchanged: pages bounce to /login, APIs 401", async () => {
    const page = await proxy(requestFor("/clients"))
    expect(page.status).toBe(307)
    expect(page.headers.get("location")).toContain("/login?returnTo=%2Fclients")
    expect(page.headers.get("set-cookie")).toBeNull()

    const api = await proxy(requestFor("/api/clients"))
    expect(api.status).toBe(401)
  })

  it("replaces a stale session cookie so the FIRST render is signed in", async () => {
    stubDemoDeployment()
    // A returning visitor whose token expired or was corrupted. cookieToken()
    // returns the FIRST match, so the minted cookie must REPLACE the stale
    // one in the forwarded request, not sit behind it.
    const response = await proxy(requestFor("/clients", `${SESSION_COOKIE}=STALE-GARBAGE`))
    expect(response.status).toBe(200)
    const injected = response.headers.get("x-middleware-request-cookie") ?? ""
    expect(injected).not.toContain("STALE-GARBAGE")
    await expect(
      resolveCadenceSession(
        new Request("http://cadence.internal/", { headers: { cookie: injected } }),
      ),
    ).resolves.toMatchObject({ subject: MAYA.subject })
  })

  it("keeps unrelated cookies when replacing the session cookie", async () => {
    stubDemoDeployment()
    const response = await proxy(
      requestFor("/clients", `theme=dark; ${SESSION_COOKIE}=STALE; locale=en`),
    )
    const injected = response.headers.get("x-middleware-request-cookie") ?? ""
    expect(injected).toContain("theme=dark")
    expect(injected).toContain("locale=en")
    expect(injected).not.toContain("STALE")
  })

  it("never mints over an existing valid session", async () => {
    stubDemoDeployment()
    const daniel = cadenceDemoUsers()[1]!
    const now = Math.floor(Date.now() / 1000)
    const login = await new SignJWT({ email: daniel.email, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(daniel.subject)
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(supabaseJwtSecret()))
    const response = await proxy(requestFor("/", `${SESSION_COOKIE}=${login}`))
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

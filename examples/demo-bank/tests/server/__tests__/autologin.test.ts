import { encode, getToken } from "next-auth/jwt"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { config, proxy } from "../../../src/proxy"
import { isAutologinSession, mintAutologinSession, sessionCookieName } from "../../../src/server/autologin"

afterEach(() => vi.unstubAllEnvs())

function requestFor(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) },
  })
}

/** The autologin gate fails closed without a configured origin, so every
 * minting scenario stubs the demo origin explicitly (like local runs must).
 *
 * THE `/maple` IS LOAD-BEARING. It is what instrumentation.ts really primes,
 * and stubbing a prefix-FREE base collapsed the app's two vocabularies (the
 * mount-stripped path Next hands the proxy, and the public path the browser
 * uses) into one string — so the suite could not see the proxy emitting a
 * prefix-free returnTo, and sign-in landed on a 404. */
function stubDemoDeployment(): void {
  vi.stubEnv("DEMO_AUTOLOGIN", "1")
  vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000/maple")
}

/**
 * The redirect target as path+query, asserted to stay on the request's OWN
 * origin and under the mount point.
 *
 * Maple is served in place at demos.vendo.run/maple, so a bounce to a path
 * missing the `/maple` prefix lands on nothing. The origin cannot be fixed here
 * — Next's proxy runtime rejects a relative Location and emits absolute ones
 * itself — so it is rewritten at the edge; what this pins is that the proxy
 * never *introduces* a foreign origin of its own.
 */
function locationOf(response: Response, request: NextRequest): string {
  const location = new URL(response.headers.get("location")!)
  expect(location.origin).toBe(request.nextUrl.origin)
  expect(location.pathname, "every redirect stays under the mount point").toMatch(/^\/maple(?:\/|$)/u)
  return `${location.pathname}${location.search}`
}

describe("proxy matcher", () => {
  /** Next prefixes every matcher with the mount point, so the catch-all becomes
   *  `/maple/((?!…).*)` and does not match the bare `/maple` a visitor types.
   *  Dropping the explicit "/" leaves the home page as the one page the gate
   *  never sees — and it renders a signed-out visitor a signed-in page. */
  it("covers the bare mount root, not just paths under it", () => {
    expect(config.matcher).toContain("/")
  })
})

describe("auto-login session minting", () => {
  it("round-trips the proxy's unchanged getToken read path, claim included", async () => {
    const session = await mintAutologinSession()
    expect(session.name).toBe("authjs.session-token")
    const token = await getToken({
      req: requestFor("/", `${session.name}=${session.value}`),
      secret: "maple-local-development-auth-secret",
      secureCookie: false,
    })
    expect(token).toMatchObject({
      sub: "vendo-demo",
      name: "Yousef Helal",
      email: "yousef@maple.com",
      demoAutologin: true,
    })
  })

  it("uses the __Secure- cookie name (and salt) on secure deployments", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run/maple")
    expect(sessionCookieName()).toBe("__Secure-authjs.session-token")
    const session = await mintAutologinSession()
    const token = await getToken({
      req: requestFor("/", `${session.name}=${session.value}`),
      secret: "maple-local-development-auth-secret",
      secureCookie: true,
    })
    expect(token?.sub).toBe("vendo-demo")
  })

  it("flags only auto-minted sessions — a credential-login token has no claim", async () => {
    const minted = await mintAutologinSession()
    await expect(
      isAutologinSession(requestFor("/", `${minted.name}=${minted.value}`)),
    ).resolves.toBe(true)

    // What the Auth.js credentials provider mints: same secret/salt, no claim.
    const credential = await encode({
      token: { sub: "vendo-demo", name: "Yousef Helal", email: "yousef@maple.com" },
      secret: "maple-local-development-auth-secret",
      salt: sessionCookieName(),
    })
    await expect(
      isAutologinSession(requestFor("/", `${sessionCookieName()}=${credential}`)),
    ).resolves.toBe(false)
  })
})

describe("proxy auto-login behavior", () => {
  it("with DEMO_AUTOLOGIN=1 an unauthenticated page request is signed in before first paint", async () => {
    stubDemoDeployment()
    const response = await proxy(requestFor("/accounts"))
    // Not a redirect: the request itself proceeds, carrying the minted cookie.
    expect(response.status).toBe(200)
    const injected = response.headers.get("x-middleware-request-cookie")
    expect(injected).toContain("authjs.session-token=")
    const setCookie = response.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("authjs.session-token=")
    // The minted cookie is a real session for the proxy's own read path.
    const value = /authjs\.session-token=([^;]+)/.exec(setCookie)![1]!
    const token = await getToken({
      req: requestFor("/", `authjs.session-token=${value}`),
      secret: "maple-local-development-auth-secret",
      secureCookie: false,
    })
    expect(token).toMatchObject({ sub: "vendo-demo", demoAutologin: true })
  })

  it("the real /logout continuation lands signed-in: /login redirects into the product with a fresh session", async () => {
    stubDemoDeployment()
    // /logout clears the cookie and 303s to /login — with the flag that
    // continuation must never show a login form.
    const request = requestFor("/login")
    const response = await proxy(request)
    expect(response.status).toBe(307)
    expect(locationOf(response, request)).toBe("/maple")
    expect(response.headers.get("set-cookie")).toContain("authjs.session-token=")
  })

  it("/login honors a same-origin returnTo and collapses foreign ones", async () => {
    stubDemoDeployment()
    // returnTo arrives in the PUBLIC spelling — it came from a browser — and is
    // emitted unchanged. Re-prefixing it here is what produced /maple/maple/….
    const sameRequest = requestFor("/login?returnTo=%2Fmaple%2Faccounts%3Ftab%3Dsavings")
    const same = await proxy(sameRequest)
    expect(locationOf(same, sameRequest)).toBe("/maple/accounts?tab=savings")
    const foreignRequest = requestFor(`/login?returnTo=${encodeURIComponent("https://evil.example/phish")}`)
    const foreign = await proxy(foreignRequest)
    expect(locationOf(foreign, foreignRequest)).toBe("/maple")
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
    const spoofed = new NextRequest("https://demos.vendo.run/accounts", {
      headers: { host: "bank.victim.example", "x-forwarded-host": "demos.vendo.run" },
    })
    const response = await proxy(spoofed)
    // Normal unauthenticated flow: bounce to /login, nothing minted.
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get("location")!).pathname).toBe("/maple/login")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("host binding: a missing Host header never mints", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    const hostless = new NextRequest("https://demos.vendo.run/accounts")
    const response = await proxy(hostless)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("fails closed: no VENDO_BASE_URL means no minting, not even for loopback", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    const loopback = new NextRequest("http://127.0.0.1:3000/accounts", {
      headers: { host: "127.0.0.1:3000" },
    })
    const response = await proxy(loopback)
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get("location")!).pathname).toBe("/maple/login")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("host binding: the configured demo origin (VENDO_BASE_URL) does mint", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    const demo = new NextRequest("https://demos.vendo.run/accounts", {
      headers: { host: "demos.vendo.run" },
    })
    const response = await proxy(demo)
    expect(response.status).toBe(200)
    // Secure deployment ⇒ the __Secure- cookie name.
    expect(response.headers.get("set-cookie")).toContain("__Secure-authjs.session-token=")
  })

  it("rejects malformed authorities that a URL parser would smuggle the demo host through", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "http://127.0.0.1:4300")
    const smuggled = [
      "victim.example@127.0.0.1:4300", // userinfo — URL.host would be the demo host
      "127.0.0.1:4300#victim.example", // fragment — discarded by a URL parser
      "127.0.0.1:4300/victim.example", // path — discarded by a URL parser
      "127.0.0.1:4300?victim.example", // query — discarded by a URL parser
      // Leading/trailing whitespace never reaches the gate: the Fetch
      // Headers layer strips optional whitespace (RFC 9110) on the way in,
      // so the app only ever sees the bare value. Embedded whitespace
      // survives, and the authority check rejects it:
      "127.0.0.1:4300\tx",
      "127.0.0.1 4300",
      "[127.0.0.1]:4300", // brackets
      "127.0.0.1:4300:4300", // double colon
      "127..0.0.1:4300", // empty label
      ".127.0.0.1:4300", // leading dot ⇒ empty label
      "127.0.0.1:4300@victim.example", // demo host in the userinfo position
    ]
    for (const host of smuggled) {
      const response = await proxy(
        new NextRequest("http://127.0.0.1:4300/accounts", { headers: { host } }),
      )
      expect(response.headers.get("set-cookie"), `Host: ${JSON.stringify(host)}`).toBeNull()
    }
  })

  it("rejects an ambiguous Host: duplicate fields the runtime collapses into one value", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    vi.stubEnv("VENDO_BASE_URL", "https://demos.vendo.run")
    // Two Host fields: undici joins them, and the joined value is exactly
    // what a smuggled duplicate looks like. Never guess which one routed.
    const duplicate = new NextRequest("https://demos.vendo.run/accounts", {
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
      new NextRequest("https://demos.vendo.run/accounts", {
        headers: { host: "demos.vendo.run", "x-forwarded-host": "DEMOS.VENDO.RUN:443" },
      }),
    )
    expect(agreeing.headers.get("set-cookie")).toContain("__Secure-authjs.session-token=")

    // Disagreement ⇒ no mint, even though Host alone is the demo origin.
    const disagreeing = await proxy(
      new NextRequest("https://demos.vendo.run/accounts", {
        headers: { host: "demos.vendo.run", "x-forwarded-host": "victim.example" },
      }),
    )
    expect(disagreeing.headers.get("set-cookie")).toBeNull()

    // Ambiguous XFH ⇒ no mint.
    const ambiguous = await proxy(
      new NextRequest("https://demos.vendo.run/accounts", {
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
        new NextRequest("https://demos.vendo.run/accounts", { headers: { host } }),
      )
      expect(response.headers.get("set-cookie"), `Host: ${host}`).toContain("authjs.session-token=")
    }
    // A NON-default port is a different host.
    const wrongPort = await proxy(
      new NextRequest("https://demos.vendo.run/accounts", { headers: { host: "demos.vendo.run:8443" } }),
    )
    expect(wrongPort.headers.get("set-cookie")).toBeNull()
  })

  it("without the flag, unauthenticated behavior is unchanged: pages bounce to /login, APIs 401", async () => {
    const page = await proxy(requestFor("/accounts"))
    expect(page.status).toBe(307)
    // returnTo is handed to the BROWSER, so it is the public spelling. It used
    // to be the mount-stripped %2Faccounts, and signing in landed on a 404.
    expect(page.headers.get("location")).toContain("/login?returnTo=%2Fmaple%2Faccounts")
    expect(page.headers.get("set-cookie")).toBeNull()

    const api = await proxy(requestFor("/api/accounts"))
    expect(api.status).toBe(401)
  })

  /** The whole signed-out round trip in one place, under the PREFIXED base URL a
   *  real deployment sets: bounce → the returnTo the browser gets → what the
   *  login continuation resolves it back to. Every hop stays under /maple and
   *  none of them doubles it. */
  it("round-trips signed-out → /login → back to the page, one prefix at every hop", async () => {
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000/maple")
    const bounce = await proxy(requestFor("/accounts?tab=savings"))
    const returnTo = new URL(bounce.headers.get("location")!).searchParams.get("returnTo")
    expect(returnTo).toBe("/maple/accounts?tab=savings")

    // The continuation the login form (and auto-login) resolves that returnTo to.
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    const back = requestFor(`/login?returnTo=${encodeURIComponent(returnTo!)}`)
    expect(locationOf(await proxy(back), back)).toBe("/maple/accounts?tab=savings")
  })

  it("replaces a stale session cookie so the FIRST render is signed in", async () => {
    stubDemoDeployment()
    // A returning visitor whose cookie expired or was corrupted. The minted
    // cookie must REPLACE it in the forwarded request: cookie parsers take
    // the first match, so merely appending would leave the stale value
    // winning and the first render unauthenticated.
    const response = await proxy(requestFor("/accounts", "authjs.session-token=STALE-GARBAGE"))
    expect(response.status).toBe(200)
    const injected = response.headers.get("x-middleware-request-cookie") ?? ""
    expect(injected).not.toContain("STALE-GARBAGE")
    const token = await getToken({
      req: requestFor("/", injected),
      secret: "maple-local-development-auth-secret",
      secureCookie: false,
    })
    expect(token).toMatchObject({ sub: "vendo-demo", demoAutologin: true })
  })

  it("keeps unrelated cookies when replacing the session cookie", async () => {
    stubDemoDeployment()
    const response = await proxy(
      requestFor("/accounts", "theme=dark; authjs.session-token=STALE; locale=en"),
    )
    const injected = response.headers.get("x-middleware-request-cookie") ?? ""
    expect(injected).toContain("theme=dark")
    expect(injected).toContain("locale=en")
    expect(injected).not.toContain("STALE")
  })

  it("never mints over an existing valid session", async () => {
    stubDemoDeployment()
    const credential = await encode({
      token: { sub: "maple-mia", name: "Mia Nakamura", email: "mia@maple.com" },
      secret: "maple-local-development-auth-secret",
      salt: sessionCookieName(),
    })
    const response = await proxy(requestFor("/", `authjs.session-token=${credential}`))
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

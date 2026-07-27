import { encode, getToken } from "next-auth/jwt"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { proxy } from "../../proxy"
import { isAutologinSession, mintAutologinSession, sessionCookieName } from "../autologin"

afterEach(() => vi.unstubAllEnvs())

function requestFor(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  })
}

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
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
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

  it("with the flag, a signed-out visitor (post-/logout) is signed in again on the next request", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    // /logout cleared the cookie; the next request carries none and re-mints.
    const response = await proxy(requestFor("/"))
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("authjs.session-token=")
  })

  it("without the flag, unauthenticated behavior is unchanged: pages bounce to /login, APIs 401", async () => {
    const page = await proxy(requestFor("/accounts"))
    expect(page.status).toBe(307)
    expect(page.headers.get("location")).toContain("/login?returnTo=%2Faccounts")
    expect(page.headers.get("set-cookie")).toBeNull()

    const api = await proxy(requestFor("/api/accounts"))
    expect(api.status).toBe(401)
  })

  it("never mints over an existing valid session", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
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

import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { proxy } from "../../proxy"
import { isAutologinToken, mintAutologinToken } from "../autologin"
import { resolveCadenceSession, SESSION_COOKIE } from "../session"
import { cadenceDemoUsers, supabaseAnonKey, supabaseJwtSecret } from "../users"

afterEach(() => vi.unstubAllEnvs())

const MAYA = cadenceDemoUsers()[0]!

function requestFor(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    headers: cookie ? { cookie } : {},
  })
}

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

  it("with DEMO_AUTOLOGIN=1 the Supabase env is not required (no GoTrue dependency)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
    expect(supabaseJwtSecret()).toBe("super-secret-jwt-token-with-at-least-32-characters-long")
    expect(supabaseAnonKey().split(".")).toHaveLength(3)
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
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
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

  it("without the flag, unauthenticated behavior is unchanged: pages bounce to /login, APIs 401", async () => {
    const page = await proxy(requestFor("/clients"))
    expect(page.status).toBe(307)
    expect(page.headers.get("location")).toContain("/login?returnTo=%2Fclients")
    expect(page.headers.get("set-cookie")).toBeNull()

    const api = await proxy(requestFor("/api/clients"))
    expect(api.status).toBe(401)
  })

  it("never mints over an existing valid session", async () => {
    vi.stubEnv("DEMO_AUTOLOGIN", "1")
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

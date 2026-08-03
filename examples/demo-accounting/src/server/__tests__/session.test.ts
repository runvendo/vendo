import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cadenceDemoUsers, supabaseAnonKey, supabaseJwtSecret } from "../users"
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  resolveCadenceSession,
  sessionCookie,
} from "../session"

afterEach(() => vi.unstubAllEnvs())

const [MAYA] = cadenceDemoUsers()

interface MintOptions {
  role?: string
  audience?: string
  secret?: string
  expiresAt?: number
}

/** Mint a GoTrue-shaped access token the way Supabase local would. */
async function accessToken(sub: string, options: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    role: options.role ?? "authenticated",
    email: sub === MAYA!.subject ? MAYA!.email : undefined,
    user_metadata: sub === MAYA!.subject ? { name: MAYA!.display } : {},
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(new TextEncoder().encode(options.secret ?? supabaseJwtSecret()))
}

function withCookie(token: string): Request {
  return new Request("http://localhost:3000/", {
    headers: { cookie: `theme=paper; ${SESSION_COOKIE}=${token}` },
  })
}

function withBearer(token: string): Request {
  return new Request("http://localhost:3000/api/clients", {
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("resolveCadenceSession", () => {
  it("resolves a session cookie holding a real Supabase access token", async () => {
    const token = await accessToken(MAYA!.subject)
    await expect(resolveCadenceSession(withCookie(token))).resolves.toEqual({
      subject: MAYA!.subject,
      display: MAYA!.display,
      email: MAYA!.email,
    })
  })

  it("resolves an Authorization bearer token (what actAs-minted requests carry)", async () => {
    const token = await accessToken(MAYA!.subject)
    await expect(resolveCadenceSession(withBearer(token))).resolves.toMatchObject({
      subject: MAYA!.subject,
    })
  })

  it("falls back to the email for display when metadata has no name", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({ role: "authenticated", email: "pat@cadence.test" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("57b1f8e5-3f6a-4b2c-9d0e-1a2b3c4d5e6f")
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(supabaseJwtSecret()))
    await expect(resolveCadenceSession(withCookie(token))).resolves.toMatchObject({
      display: "pat@cadence.test",
    })
  })

  it("rejects tampered, expired, wrong-secret, and absent tokens", async () => {
    const token = await accessToken(MAYA!.subject)
    await expect(resolveCadenceSession(withCookie(`${token.slice(0, -2)}xx`))).resolves.toBeNull()
    await expect(
      resolveCadenceSession(withCookie(await accessToken(MAYA!.subject, {
        expiresAt: Math.floor(Date.now() / 1000) - 10,
      }))),
    ).resolves.toBeNull()
    await expect(
      resolveCadenceSession(withCookie(await accessToken(MAYA!.subject, {
        secret: "some-other-project-secret-with-enough-length",
      }))),
    ).resolves.toBeNull()
    await expect(resolveCadenceSession(new Request("http://localhost:3000/"))).resolves.toBeNull()
  })

  it("verifies ES256 login tokens against GoTrue's JWKS", async () => {
    // `supabase start` ≥ v2.71 signs login access tokens with an asymmetric
    // ES256 key published at /auth/v1/.well-known/jwks.json.
    const { publicKey, privateKey } = await generateKeyPair("ES256")
    const jwk = { ...(await exportJWK(publicKey)), kid: "local-test-kid", alg: "ES256" }
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    vi.stubEnv("SUPABASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const now = Math.floor(Date.now() / 1000)
      const token = await new SignJWT({ role: "authenticated", user_metadata: { name: MAYA!.display } })
        .setProtectedHeader({ alg: "ES256", kid: "local-test-kid", typ: "JWT" })
        .setSubject(MAYA!.subject)
        .setAudience("authenticated")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey)
      await expect(resolveCadenceSession(withCookie(token))).resolves.toMatchObject({
        subject: MAYA!.subject,
        display: MAYA!.display,
      })
      // A different ES256 key does not verify.
      const { privateKey: strangerKey } = await generateKeyPair("ES256")
      const forged = await new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "local-test-kid", typ: "JWT" })
        .setSubject(MAYA!.subject)
        .setAudience("authenticated")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(strangerKey)
      await expect(resolveCadenceSession(withCookie(forged))).resolves.toBeNull()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("rejects algorithms outside HS256/ES256 without any verification attempt", async () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url")
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: MAYA!.subject,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`
    await expect(resolveCadenceSession(withCookie(unsigned))).resolves.toBeNull()
  })

  it("rejects Supabase API keys presented as sessions (role/audience gate)", async () => {
    // The local anon key is itself an HS256 JWT signed with the same project
    // secret — it must never count as a signed-in user.
    await expect(resolveCadenceSession(withBearer(supabaseAnonKey()))).resolves.toBeNull()
    await expect(
      resolveCadenceSession(withCookie(await accessToken(MAYA!.subject, { role: "service_role" }))),
    ).resolves.toBeNull()
    await expect(
      resolveCadenceSession(withCookie(await accessToken(MAYA!.subject, { audience: "anon" }))),
    ).resolves.toBeNull()
  })
})

describe("session cookie builders", () => {
  it("builds an HttpOnly Lax cookie, Secure only behind https", () => {
    expect(sessionCookie("tok", 3600)).toBe(
      `${SESSION_COOKIE}=tok; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`,
    )
    vi.stubEnv("VENDO_BASE_URL", "https://cadence.example.com")
    expect(sessionCookie("tok", 3600)).toContain("; Secure")
    expect(clearedSessionCookie()).toContain("Max-Age=0")
  })
})

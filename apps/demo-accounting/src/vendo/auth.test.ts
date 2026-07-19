import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { PermissionGrant } from "@vendoai/core"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_COOKIE, resolveCadenceSession } from "@/server/session"
import { cadenceDemoUsers, supabaseJwtSecret } from "@/server/users"
import { cadenceAuth, safeReturnTo } from "./auth"

afterEach(() => vi.unstubAllEnvs())

const [MAYA, DANIEL] = cadenceDemoUsers()

function grantFor(subject: string): PermissionGrant {
  return {
    id: "grt_test",
    subject,
    tool: "host_sendClientMessage",
    descriptorHash: "sha256:test",
    scope: { kind: "tool" },
    duration: "standing",
    source: "automation",
    grantedAt: "2026-07-15T00:00:00.000Z",
  }
}

/** Mint a GoTrue-shaped HS256 access token the way Supabase local would. */
async function accessToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(supabaseJwtSecret()))
}

function withSessionCookie(token: string): Request {
  return new Request("http://localhost:3000/api/vendo/threads", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
}

describe("cadenceAuth (the shipped supabase() preset, Cadence-configured)", () => {
  it("resolves the login session cookie to the seeded Vendo principal", async () => {
    // The cookie the /login route sets is readable by the shipped preset —
    // Cadence's cookie name follows Supabase's `sb-<ref>-auth-token` shape.
    const request = withSessionCookie(await accessToken(MAYA!.subject))
    await expect(cadenceAuth.principal(request)).resolves.toEqual({
      kind: "user",
      subject: MAYA!.subject,
      display: MAYA!.display,
    })
  })

  it("declines unseeded subjects and sessionless requests", async () => {
    const stranger = "1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a"
    await expect(cadenceAuth.principal(withSessionCookie(await accessToken(stranger))))
      .resolves.toBeNull()
    await expect(cadenceAuth.principal(new Request("http://localhost:3000/api/vendo/threads")))
      .resolves.toBeNull()
  })

  it("verifies an ES256 login token against GoTrue's JWKS (supabase start ≥ v2.71)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256")
    const jwk = { ...(await exportJWK(publicKey)), kid: "cadence-test-kid", alg: "ES256" }
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    vi.stubEnv("SUPABASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    try {
      const now = Math.floor(Date.now() / 1000)
      const token = await new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "cadence-test-kid", typ: "JWT" })
        .setSubject(DANIEL!.subject)
        .setAudience("authenticated")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey)
      await expect(cadenceAuth.principal(withSessionCookie(token))).resolves.toEqual({
        kind: "user",
        subject: DANIEL!.subject,
        display: DANIEL!.display,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("cadenceAuth actAs half (shipped Supabase minting preset)", () => {
  it("mints an away token Cadence's own session verification accepts", async () => {
    const material = await cadenceAuth.actAs!(
      { kind: "user", subject: DANIEL!.subject, display: DANIEL!.display },
      grantFor(DANIEL!.subject),
    )
    expect(material?.headers.authorization).toMatch(/^Bearer /)
    // Round trip through the same verifier the proxy wall uses.
    const request = new Request("http://localhost:3000/api/clients", {
      headers: material!.headers,
    })
    await expect(resolveCadenceSession(request)).resolves.toEqual({
      subject: DANIEL!.subject,
      display: DANIEL!.display,
      email: DANIEL!.email,
    })
    // And through the preset's own principal seam (the doctor round-trip).
    await expect(cadenceAuth.principal(request)).resolves.toEqual({
      kind: "user",
      subject: DANIEL!.subject,
      display: DANIEL!.display,
    })
  })

  it("declines subjects Cadence never seeded", async () => {
    await expect(cadenceAuth.actAs!(
      { kind: "user", subject: "1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a" },
      grantFor("1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a"),
    )).resolves.toBeNull()
  })

  it("fails loud when the project JWT secret is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production")
    // supabaseJwtSecret() throws without SUPABASE_JWT_SECRET in production;
    // the preset must surface that, not mint with a default.
    await expect(cadenceAuth.actAs!(
      { kind: "user", subject: MAYA!.subject },
      grantFor(MAYA!.subject),
    )).rejects.toThrow(/SUPABASE_JWT_SECRET/)
  })
})

describe("safeReturnTo", () => {
  it("only accepts same-origin return targets", () => {
    vi.stubEnv("VENDO_BASE_URL", "https://cadence.example.com")
    expect(safeReturnTo("https://cadence.example.com/clients/cl_rivera?tab=docs"))
      .toBe("/clients/cl_rivera?tab=docs")
    expect(safeReturnTo("/work")).toBe("/work")
    expect(safeReturnTo("https://attacker.example/callback")).toBe("/")
    expect(safeReturnTo(null)).toBe("/")
  })
})

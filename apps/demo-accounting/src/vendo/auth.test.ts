import type { PermissionGrant } from "@vendoai/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveCadenceSession } from "@/server/session"
import { cadenceDemoUsers } from "@/server/users"
import { actAsCadenceUser, resolveCadencePrincipal, safeReturnTo } from "./auth"

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

describe("actAsCadenceUser (Supabase preset)", () => {
  it("mints an away token Cadence's own session verification accepts", async () => {
    const material = await actAsCadenceUser(
      { kind: "user", subject: DANIEL!.subject, display: DANIEL!.display },
      grantFor(DANIEL!.subject),
    )
    expect(material?.headers.authorization).toMatch(/^Bearer /)
    // Round trip through the same verifier the proxy wall and principal use.
    const request = new Request("http://localhost:3000/api/clients", {
      headers: material!.headers,
    })
    await expect(resolveCadenceSession(request)).resolves.toEqual({
      subject: DANIEL!.subject,
      display: DANIEL!.display,
      email: DANIEL!.email,
    })
    await expect(resolveCadencePrincipal(request)).resolves.toEqual({
      kind: "user",
      subject: DANIEL!.subject,
      display: DANIEL!.display,
    })
  })

  it("declines subjects Cadence never seeded", async () => {
    await expect(actAsCadenceUser(
      { kind: "user", subject: "1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a" },
      grantFor("1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a"),
    )).resolves.toBeNull()
  })

  it("declines when the project JWT secret is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production")
    // supabaseJwtSecret() throws without SUPABASE_JWT_SECRET in production;
    // the preset must surface that as a decline, not a minted token.
    await expect(actAsCadenceUser(
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

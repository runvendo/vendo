import { encode } from "next-auth/jwt"
import { describe, expect, it } from "vitest"
import { GET } from "../../../../src/app/api/profile/route"

/**
 * The profile route overrides the shared financial seed's IDENTITY with whoever
 * is actually signed in. It replaced name and email but not `avatarInitials`, so
 * the sidebar and the account switcher both still read "YH" when Mia signs in —
 * in every two-user screenshot of this demo.
 */

const COOKIE = "authjs.session-token"
const DEV_SECRET = "maple-local-development-auth-secret"

async function requestAs(sub: string): Promise<Request> {
  const token = await encode({ token: { sub }, secret: DEV_SECRET, salt: COOKIE, maxAge: 300 })
  return new Request("http://localhost:3000/api/profile", { headers: { cookie: `${COOKIE}=${token}` } })
}

const bodyOf = async (request: Request): Promise<Record<string, unknown>> =>
  ((await (await GET(request)).json()) as { data: Record<string, unknown> }).data

const profileFor = async (sub: string): Promise<Record<string, unknown>> =>
  await bodyOf(await requestAs(sub))

describe("GET /api/profile — the identity is the signed-in person's, all of it", () => {
  it("derives the avatar initials from the signed-in name", async () => {
    const mia = await profileFor("maple-mia")
    expect(mia.name).toBe("Mia Nakamura")
    expect(mia.avatarInitials).toBe("MN")

    const yousef = await profileFor("vendo-demo")
    expect(yousef.name).toBe("Yousef Helal")
    expect(yousef.avatarInitials).toBe("YH")
  })

  it("leaves the seed's own initials alone when nobody is signed in, and hides staff", async () => {
    const anonymous = await bodyOf(new Request("http://localhost:3000/api/profile"))
    expect(anonymous.avatarInitials).toBe("YH")
    expect(anonymous.staff).toBeUndefined()
  })
})

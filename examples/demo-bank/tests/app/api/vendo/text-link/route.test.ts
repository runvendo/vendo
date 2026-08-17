import { encode } from "next-auth/jwt"
import { describe, expect, it } from "vitest"
import { GET } from "../../../../../src/app/api/vendo/text-link/route"

/**
 * The route behind the "Text with Maple" modal.
 *
 * This suite runs with no VENDO_API_KEY, which is exactly the posture the route
 * has to survive: `channels: { text: true }` with no Cloud key composes the
 * unconfigured channel (selectChannels), so minting an invite refuses. The modal
 * reads that as `url: null` and says so; a 500 here would put a broken dialog on
 * the settings page of every keyless checkout of this demo.
 */

const COOKIE = "authjs.session-token"
const DEV_SECRET = "maple-local-development-auth-secret"

const linkFor = async (sub: string): Promise<Response> => {
  const token = await encode({ token: { sub }, secret: DEV_SECRET, salt: COOKIE, maxAge: 300 })
  return GET(new Request("http://localhost:3000/api/vendo/text-link", {
    headers: { cookie: `${COOKIE}=${token}` },
  }))
}

describe("GET /api/vendo/text-link", () => {
  it("answers url: null — not a 500 — when the deployment has no text channel", async () => {
    const response = await linkFor("vendo-demo")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: { url: null } })
  })

  it("answers a signed-out visitor the same way, since Maple resolves them to its guest", async () => {
    const response = await GET(new Request("http://localhost:3000/api/vendo/text-link"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: { url: null } })
  })
})

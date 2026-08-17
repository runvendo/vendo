import { VendoError } from "@vendoai/core"
import { encode } from "next-auth/jwt"
import { describe, expect, it, vi } from "vitest"
import { GET } from "../../../../../src/app/api/vendo/text-link/route"
import { vendo } from "../../../../../src/vendo/server"

/**
 * The route behind the "Text with Maple" modal.
 *
 * This suite runs with no VENDO_API_KEY, which is exactly the posture the route
 * has to survive: `channels: { text: true }` with no Cloud key composes the
 * unconfigured channel (selectChannels), so minting an invite refuses. The modal
 * reads that as `url: null` and says so; a 500 here would put a broken dialog on
 * the settings page of every keyless checkout of this demo.
 *
 * The other half matters just as much: `url: null` means "not available on this
 * deployment", and the modal does not revalidate — so answering it for a passing
 * OUTAGE would tell a customer their text channel is switched off and keep saying
 * it after the outage cleared.
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

describe("a broken channel is not a channel that is switched off", () => {
  it("answers 503 when minting fails for an operational reason", async () => {
    // A console outage, a store blip, a vendor timeout. Distinct from the
    // configuration cases above, which really do mean "no texting here".
    const minting = vi.spyOn(vendo.channels.text, "link").mockRejectedValue(
      new VendoError("unavailable", "Vendo Cloud channels is unavailable"),
    )
    try {
      const response = await linkFor("vendo-demo")

      expect(response.status).toBe(503)
      const body = await response.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("server_error")
    } finally {
      minting.mockRestore()
    }
  })

  it("still answers url: null when the deployment simply has no Cloud key", async () => {
    // The `not-implemented` half of the configuration case, pinned explicitly so
    // the two never collapse back into one catch.
    const minting = vi.spyOn(vendo.channels.text, "link").mockRejectedValue(
      new VendoError("not-implemented", "the text channel needs VENDO_API_KEY"),
    )
    try {
      const response = await linkFor("vendo-demo")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ data: { url: null } })
    } finally {
      minting.mockRestore()
    }
  })
})

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
  /** The route answers "no channel here" from the CONFIGURATION, so reaching the
   *  mint at all takes a configured-looking deployment. */
  const configured = <T,>(run: () => Promise<T>): Promise<T> => {
    vi.stubEnv("VENDO_API_KEY", "vk_live_test")
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test")
    return run().finally(() => vi.unstubAllEnvs())
  }

  it("answers 503 when minting fails for an operational reason", async () => {
    // A console outage, a store blip, a vendor timeout. Distinct from the
    // configuration cases above, which really do mean "no texting here".
    const minting = vi.spyOn(vendo.channels.text, "link").mockRejectedValue(
      new VendoError("unavailable", "Vendo Cloud channels is unavailable"),
    )
    try {
      const response = await configured(() => linkFor("vendo-demo"))

      expect(response.status).toBe(503)
      const body = await response.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("server_error")
    } finally {
      minting.mockRestore()
    }
  })

  it("treats the local-dev loopback URL as no channel, not as a retriable fault", async () => {
    // instrumentation.ts fills an unset VENDO_BASE_URL with
    // http://localhost:<port>/maple, so the var is never empty at runtime. Cloud
    // cannot deliver an inbound text to a laptop, so this is permanent — offering
    // a "try again" for it would be offering a retry that can never succeed.
    const minting = vi.spyOn(vendo.channels.text, "link")
    vi.stubEnv("VENDO_API_KEY", "vk_live_test")
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000/maple")
    try {
      const response = await linkFor("vendo-demo")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ data: { url: null } })
      expect(minting, "nowhere to deliver, so nothing to mint").not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      minting.mockRestore()
    }
  })

  it("never even asks when the deployment is not configured for texting", async () => {
    // The permanent answer comes from configuration, not from an error shape —
    // `validation` covers both "no VENDO_BASE_URL" (a setting) and "Cloud
    // returned no identity" (an outage), so no code-based rule separates them.
    const minting = vi.spyOn(vendo.channels.text, "link")

    const response = await linkFor("vendo-demo")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: { url: null } })
    expect(minting, "no key, no call").not.toHaveBeenCalled()
    minting.mockRestore()
  })
})

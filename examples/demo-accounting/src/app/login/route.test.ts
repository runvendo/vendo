/**
 * The /login POST's GoTrue status mapping. GoTrue is shared machine-wide
 * (fixed port from `supabase start`), so under parallel test/dev load it can
 * answer 429 (rate limit) or 5xx for a PERFECTLY CORRECT password. Those
 * transient answers must not be reported as "Email or password is incorrect"
 * (401) — callers (and the login e2e) need to tell a real credential
 * rejection apart from a GoTrue-side hiccup.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cadenceDemoEmail, cadenceDemoPassword } from "@/server/users"
import { POST } from "./route"

afterEach(() => vi.unstubAllEnvs())

interface GotrueStub {
  close(): Promise<void>
}

/** A GoTrue stand-in answering every request with one fixed status/body. */
async function stubGotrue(status: number, body: unknown): Promise<GotrueStub> {
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  vi.stubEnv("SUPABASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  return { close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function loginPost(): Request {
  const form = new URLSearchParams({
    email: cadenceDemoEmail(),
    password: cadenceDemoPassword(),
    returnTo: "/",
  })
  return new Request("http://localhost:3000/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
}

describe("POST /login GoTrue status mapping", () => {
  it("surfaces a GoTrue 429 as 429, not as a wrong password", async () => {
    const gotrue = await stubGotrue(429, { error: "over_request_rate_limit" })
    try {
      const response = await POST(loginPost())
      expect(response.status).toBe(429)
      const html = await response.text()
      expect(html).not.toContain("Email or password is incorrect")
      expect(html).toContain("Too many sign-in attempts")
    } finally {
      await gotrue.close()
    }
  })

  it("surfaces a GoTrue 5xx as 502, not as a wrong password", async () => {
    const gotrue = await stubGotrue(500, { error: "internal_server_error" })
    try {
      const response = await POST(loginPost())
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain("Email or password is incorrect")
    } finally {
      await gotrue.close()
    }
  })

  it("keeps a GoTrue 400 as the 401 wrong-password page", async () => {
    const gotrue = await stubGotrue(400, { error: "invalid_grant" })
    try {
      const response = await POST(loginPost())
      expect(response.status).toBe(401)
      expect(await response.text()).toContain("Email or password is incorrect")
    } finally {
      await gotrue.close()
    }
  })

  it("still turns a successful grant into the 303 + session cookie", async () => {
    const gotrue = await stubGotrue(200, { access_token: "token-under-test", expires_in: 3600 })
    try {
      const response = await POST(loginPost())
      expect(response.status).toBe(303)
      expect(response.headers.get("set-cookie")).toContain("token-under-test")
    } finally {
      await gotrue.close()
    }
  })
})

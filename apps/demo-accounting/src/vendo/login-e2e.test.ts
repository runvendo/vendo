/**
 * ENG-260 login e2e: the real browser-shaped flow against Supabase local —
 * the /login form posts the seeded email/password, GoTrue's password grant
 * verifies it, and the resulting Supabase access token (an ES256 JWT under
 * `supabase start` ≥ v2.71) becomes the session cookie the proxy wall and
 * the Vendo principal both accept.
 *
 * Supabase-dependent by design: it probes GoTrue first and SKIPS CLEANLY
 * when the local stack isn't running, so it never becomes a hard dependency
 * for unrelated repo tests. Start the stack with `supabase start` in
 * apps/demo-accounting (see README); CI runs it in the dedicated
 * cadence-supabase-auth job.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cadenceDemoEmail, cadenceDemoPassword, cadenceDemoUsers, supabaseUrl } from "../server/users"
import { appFetch, bootCadence, BOOT_MS, type CadenceApp } from "./e2e-harness"

async function gotrueUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/auth/v1/health", supabaseUrl()), {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

const supabaseRunning = await gotrueUp()

let app: CadenceApp | undefined

async function login(email: string, password: string): Promise<Response> {
  const form = new URLSearchParams({ email, password, returnTo: "/" })
  return appFetch(`${app!.baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  })
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? ""
  const session = setCookie.split(",").find((part) => part.trim().startsWith("cadence-session="))
  expect(session, `expected a cadence-session cookie in: ${setCookie}`).toBeDefined()
  return session!.split(";")[0]!.trim()
}

beforeAll(async () => {
  if (!supabaseRunning) return
  app = await bootCadence(".next/login-e2e")
}, BOOT_MS)

afterAll(async () => {
  await app?.stop()
})

describe.skipIf(!supabaseRunning)("Cadence Supabase login (ENG-260)", () => {
  it("renders a scriptable login form", { timeout: 120_000 }, async () => {
    const page = await appFetch(`${app!.baseUrl}/login`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('name="email"')
    expect(html).toContain('name="password"')
    expect(html).toContain(cadenceDemoEmail())
  })

  it("signs the seeded user in through GoTrue's real password grant", { timeout: 120_000 }, async () => {
    const response = await login(cadenceDemoEmail(), cadenceDemoPassword())
    expect(response.status).toBe(303)
    const cookie = sessionCookieFrom(response)

    // The session cookie passes the proxy wall and resolves to the seeded
    // Supabase user id on the firm API.
    const [maya] = cadenceDemoUsers()
    const dashboard = await appFetch(`${app!.baseUrl}/api/dashboard`, { headers: { cookie } })
    expect(dashboard.status).toBe(200)

    // Sanity: the token in the cookie is a Supabase JWT for the seeded user.
    const token = cookie.slice("cadence-session=".length)
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
      sub: string
      role: string
    }
    expect(payload.sub).toBe(maya!.subject)
    expect(payload.role).toBe("authenticated")
  })

  it("rejects a wrong password and keeps the wall up", { timeout: 120_000 }, async () => {
    const response = await login(cadenceDemoEmail(), "not-the-password")
    expect(response.status).toBe(401)
    expect(await response.text()).toContain("Email or password is incorrect")

    const walled = await appFetch(`${app!.baseUrl}/api/dashboard`)
    expect(walled.status).toBe(401)
  })

  it("signs in the second seeded user too", { timeout: 120_000 }, async () => {
    const [, daniel] = cadenceDemoUsers()
    const response = await login(daniel!.email, cadenceDemoPassword())
    expect(response.status).toBe(303)
    expect(sessionCookieFrom(response)).toContain("cadence-session=")
  })
})

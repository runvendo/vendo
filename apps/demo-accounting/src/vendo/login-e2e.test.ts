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
import { SESSION_COOKIE } from "../server/session"
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
  const post = () =>
    appFetch(`${app!.baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    })
  // GoTrue is shared machine-wide (one `supabase start` stack on a fixed
  // port), so parallel test/dev load can make it answer 429/5xx even for
  // correct credentials; the route surfaces those as 429/502. Retry only the
  // transient answers — a real credential verdict (303/401) stands as-is.
  let response = await post()
  for (let attempt = 1; attempt <= 4 && [429, 502, 503].includes(response.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000))
    response = await post()
  }
  return response
}

/** Empty for the expected 303; otherwise the login page's own error line, so
 * an intermittent failure reports WHY GoTrue declined, not just the status. */
async function loginFailureDetail(response: Response): Promise<string> {
  if (response.status === 303) return ""
  const html = await response.text()
  const error = /<div class="error"[^>]*>([^<]*)<\/div>/u.exec(html)
  return `login answered ${response.status}: ${error?.[1] ?? html.slice(0, 200)}`
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? ""
  const session = setCookie.split(",").find((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
  expect(session, `expected a ${SESSION_COOKIE} cookie in: ${setCookie}`).toBeDefined()
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
    expect(response.status, await loginFailureDetail(response)).toBe(303)
    const cookie = sessionCookieFrom(response)

    // The session cookie passes the proxy wall and resolves to the seeded
    // Supabase user id on the firm API.
    const [maya] = cadenceDemoUsers()
    const dashboard = await appFetch(`${app!.baseUrl}/api/dashboard`, { headers: { cookie } })
    expect(dashboard.status).toBe(200)

    // Sanity: the token in the cookie is a Supabase JWT for the seeded user.
    const token = cookie.slice(`${SESSION_COOKIE}=`.length)
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
    expect(response.status, await loginFailureDetail(response)).toBe(303)
    expect(sessionCookieFrom(response)).toContain(`${SESSION_COOKIE}=`)
  })
})

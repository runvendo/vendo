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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cadenceDemoEmail, cadenceDemoPassword, cadenceDemoUsers, supabaseUrl } from "../server/users"

const appDir = fileURLToPath(new URL("../..", import.meta.url))
const BOOT_MS = 240_000

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

let child: ChildProcessWithoutNullStreams | undefined
let serverOutput = ""
let baseUrl = ""

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

/** Next's dev server can reset an in-flight socket while compiling a route. */
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fetch(input, init)
    } catch (error) {
      lastError = error
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
  }
  throw lastError
}

async function waitForApp(): Promise<void> {
  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`Cadence exited early (${child.exitCode})\n${serverOutput}`)
    try {
      const response = await fetch(`${baseUrl}/login`)
      if (response.ok) return
    } catch {
      // still compiling
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Cadence did not become ready\n${serverOutput}`)
}

async function login(email: string, password: string): Promise<Response> {
  const form = new URLSearchParams({ email, password, returnTo: "/" })
  return appFetch(`${baseUrl}/login`, {
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
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    VENDO_BASE_URL: baseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
    CADENCE_DIST_DIR: ".next/login-e2e",
  }
  delete (env as Record<string, string | undefined>).NODE_ENV
  const spawned = spawn(join(appDir, "node_modules", ".bin", "next"), ["dev", "-p", String(port)], {
    cwd: appDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child = spawned
  spawned.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000)
  })
  spawned.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000)
  })
  await waitForApp()
}, BOOT_MS)

afterAll(async () => {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()))
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null) child.kill("SIGKILL")
})

describe.skipIf(!supabaseRunning)("Cadence Supabase login (ENG-260)", () => {
  it("renders a scriptable login form", { timeout: 120_000 }, async () => {
    const page = await appFetch(`${baseUrl}/login`)
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
    const dashboard = await appFetch(`${baseUrl}/api/dashboard`, { headers: { cookie } })
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

    const walled = await appFetch(`${baseUrl}/api/dashboard`)
    expect(walled.status).toBe(401)
  })

  it("signs in the second seeded user too", { timeout: 120_000 }, async () => {
    const [, daniel] = cadenceDemoUsers()
    const response = await login(daniel!.email, cadenceDemoPassword())
    expect(response.status).toBe(303)
    expect(sessionCookieFrom(response)).toContain("cadence-session=")
  })
})

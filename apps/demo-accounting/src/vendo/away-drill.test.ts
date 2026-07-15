/**
 * ENG-260 away drill: an automation fires with NO live user session and its
 * action executes as the granting user against Cadence's own (now Supabase
 * Auth protected) API.
 *
 * The test boots the REAL Cadence app, then composes real store + guard +
 * actions + automations the way the umbrella does — with `actAs` set to the
 * shipped Supabase preset over the same project JWT secret the app booted
 * with. The grant is captured "while present" (enable + approve); the emit
 * carries no request headers, so the ONLY way the chase message can reach the
 * 401-walled API is the actAs-minted real Supabase user JWT. No Supabase
 * stack is required: GoTrue only verifies passwords at login — minting and
 * verifying access tokens both need just the secret.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppDocument, Principal, ToolRegistry } from "@vendoai/core"
import { createActions } from "@vendoai/actions"
import { supabasePreset } from "@vendoai/actions/presets"
import { createApps } from "@vendoai/apps"
import { createAutomations, type AutomationsEngine } from "@vendoai/automations"
import { createGuard, type VendoGuard } from "@vendoai/guard"
import { createStore, type VendoStore } from "@vendoai/store"
import { cadenceDemoUsers } from "../server/users"

const appDir = fileURLToPath(new URL("../..", import.meta.url))
const JWT_SECRET = "cadence-away-drill-project-jwt-secret"
const BOOT_MS = 240_000
const SEEDED = new Set(cadenceDemoUsers().map((user) => user.subject))
const GRANTING_USER = cadenceDemoUsers()[0]!

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

interface Stack {
  store: VendoStore
  guard: VendoGuard
  bound: ToolRegistry
  automations: AutomationsEngine
  dataDir: string
  close(): Promise<void>
}

async function cadenceTools(): Promise<Parameters<typeof createActions>[0]["tools"]> {
  const parsed = JSON.parse(await readFile(join(appDir, ".vendo", "tools.json"), "utf8")) as {
    tools: unknown[]
  }
  return parsed.tools as Parameters<typeof createActions>[0]["tools"]
}

async function createStack(): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "cadence-away-drill-"))
  const store = createStore({ dataDir })
  await store.ensureSchema()
  const guard = createGuard({ store })
  const actions = createActions({
    tools: await cadenceTools(),
    baseUrl,
    // The drill's point: away identity is a REAL Supabase user JWT minted
    // with the project's own secret. Unknown subjects are declined via
    // claims → null.
    actAs: supabasePreset({
      secret: JWT_SECRET,
      claims: (principal) => (SEEDED.has(principal.subject) ? {} : null),
    }),
    fetch: (input, init) => appFetch(String(input), init),
  })
  const bound = guard.bind(actions)
  const apps = createApps({ store, guard, tools: bound, catalog: [] })
  const automations = createAutomations({ apps, tools: bound, guard, store })
  return {
    store,
    guard,
    bound,
    automations,
    dataDir,
    async close() {
      await store.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

function chaseAutomation(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Document chase",
    trigger: {
      on: { kind: "host-event", event: "cadence.docs-overdue" },
      run: {
        kind: "steps",
        steps: [
          {
            id: "chase",
            tool: "host_sendClientMessage",
            // Steps args are JSONata expressions — strings need quoting and
            // the nested request body is a JSONata object constructor.
            args: {
              id: "'cl_rivera'",
              body: "{ 'body': 'ENG-260 away drill: please upload your outstanding March documents.', 'author': 'Cadence Automations' }",
            },
          },
        ],
      },
    },
  }
}

function ownerCtx(principal: Principal, appId: string) {
  return {
    principal,
    venue: "chat" as const,
    presence: "present" as const,
    sessionId: `sess_${principal.subject}`,
    appId,
  }
}

async function enableAndApprove(stack: Stack, subject: string, appId: string): Promise<void> {
  const principal: Principal = { kind: "user", subject }
  await stack.store.records("vendo_apps").put({
    id: appId,
    data: { subject, enabled: false, doc: chaseAutomation(appId) },
    refs: { subject },
  })
  const enabled = await stack.automations.enable(appId, ownerCtx(principal, appId))
  expect(enabled.enabled).toBe(true)
  if (enabled.missing.length > 0) {
    await stack.guard.approvals.decide(
      enabled.missing.map((request) => request.id),
      { approve: true },
      principal,
    )
  }
}

beforeAll(async () => {
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    VENDO_BASE_URL: baseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
    CADENCE_DIST_DIR: ".next/away-drill",
  }
  delete (env as Record<string, string | undefined>).NODE_ENV // vitest's "test" would leak into next dev
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

describe("Cadence away drill (ENG-260)", () => {
  it("walls the firm API off behind the real login", { timeout: 120_000 }, async () => {
    const anonymous = await appFetch(`${baseUrl}/api/clients/cl_rivera/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Nope" }),
    })
    expect(anonymous.status).toBe(401)

    const page = await appFetch(`${baseUrl}/`, { redirect: "manual" })
    expect([302, 303, 307, 308]).toContain(page.status)
    expect(page.headers.get("location")).toContain("/login")
  })

  it("executes an automation as the granting user with no live session", { timeout: 120_000 }, async () => {
    const stack = await createStack()
    try {
      const subject = GRANTING_USER.subject
      const appId = "app_away_chase"
      await enableAndApprove(stack, subject, appId)

      // No request, no cookie, no live session anywhere: the host event fires.
      const runIds = await stack.automations.emit(
        "cadence.docs-overdue",
        { requestedBy: "away-drill" },
        { kind: "user", subject },
      )
      expect(runIds).toHaveLength(1)
      const run = await stack.automations.runs.get(
        runIds[0]!,
        ownerCtx({ kind: "user", subject }, appId),
      )
      expect(run?.status).toBe("ok")
      expect(run?.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
        { id: "chase", outcome: "ok" },
      ])

      // The side effect landed in Cadence as the granting user: fetch the
      // client's thread with a minted session for that user and find the
      // drill message.
      const material = await supabasePreset({ secret: JWT_SECRET })(
        { kind: "user", subject },
        {
          id: "grt_evidence",
          subject,
          tool: "host_listClientMessages",
          descriptorHash: "sha256:evidence",
          scope: { kind: "tool" },
          duration: "session",
          source: "chat",
          grantedAt: new Date().toISOString(),
        },
      )
      const thread = await appFetch(`${baseUrl}/api/clients/cl_rivera/messages`, {
        headers: material!.headers,
      })
      expect(thread.status).toBe(200)
      const body = (await thread.json()) as { data: Array<{ body: string; author: string }> }
      const drillMessage = body.data.find((message) => message.body.includes("ENG-260 away drill"))
      expect(drillMessage).toBeDefined()
      expect(drillMessage?.author).toBe("Cadence Automations")
    } finally {
      await stack.close()
    }
  })

  it("fails closed when the grant's subject is not a seeded Cadence user", { timeout: 120_000 }, async () => {
    const stack = await createStack()
    try {
      const subject = "1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a"
      const appId = "app_away_ghost"
      await enableAndApprove(stack, subject, appId)
      const runIds = await stack.automations.emit(
        "cadence.docs-overdue",
        {},
        { kind: "user", subject },
      )
      const run = await stack.automations.runs.get(
        runIds[0]!,
        ownerCtx({ kind: "user", subject }, appId),
      )
      // actAs declines (claims → null) → the step surfaces the seam error and
      // nothing reaches Cadence's API.
      expect(run?.status).not.toBe("ok")
    } finally {
      await stack.close()
    }
  })
})

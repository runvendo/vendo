/**
 * ENG-260 away drill: an automation fires with NO live user session and its
 * action executes as the granting user against Cadence's own (now Supabase
 * Auth protected) API.
 *
 * The test boots the REAL Cadence app, then composes real store + guard +
 * actions + automations the way the umbrella does — with `actAs` set to the
 * shipped Supabase preset over the same project JWT secret the app booted
 * with. The grant is captured "while present" (enable + approve); the emit
 * carries no request headers, so the ONLY way the write can reach the
 * 401-walled API is the actAs-minted real Supabase user JWT. No Supabase
 * stack is required: GoTrue only verifies passwords at login — minting and
 * verifying access tokens both need just the secret.
 *
 * The drill's executing step is `host_setDocumentStatus` — a non-destructive
 * write on Cadence's own auth-walled API — because THE LAW (design §12) means
 * a destructive-or-external tool never enters an unattended run at all:
 * automations "may **not** move money, message humans, or delete — those tools
 * are not projected into an automation run at all". This file drove
 * `host_sendClientMessage` until 2026-07-31; that expectation predates the law,
 * and messaging a human is the exact thing §12 names. The law's own behaviour
 * on that tool is now the last scenario here, so the authority mechanic and the
 * law are each proven instead of colliding.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core"
import type { AppDocument, Principal, Step, ToolDescriptor, ToolRegistry } from "@vendoai/core"
import { createActions } from "@vendoai/actions"
import { supabasePreset } from "@vendoai/actions/presets"
import { createApps } from "@vendoai/apps"
import { createAutomations, type AutomationsEngine } from "@vendoai/automations"
import { createGuard, type VendoGuard } from "@vendoai/guard"
import { createStore, type VendoStore } from "@vendoai/store"
import { cadenceDemoUsers } from "../server/users"
import { appDir, appFetch, bootCadence, BOOT_MS, type CadenceApp } from "./e2e-harness"

const JWT_SECRET = "cadence-away-drill-project-jwt-secret"
const SEEDED = new Set(cadenceDemoUsers().map((user) => user.subject))
const GRANTING_USER = cadenceDemoUsers()[0]!

/** The tool the drill executes: POST on Cadence's own auth-walled document
 *  lifecycle. Legal unattended (a non-destructive write) AND behind the 401
 *  wall, which is what keeps the actAs-minted JWT load-bearing — `/api/demo`
 *  is a public prefix (src/proxy.ts), so a demo-only write would prove nothing. */
const INTAKE_TOOL = "host_setDocumentStatus"
/** The tool THE LAW withholds: it reaches a human. */
const MESSAGE_TOOL = "host_sendClientMessage"
const DOCUMENT = { client: "cl_rivera", id: "doc_rivera_w2" }
const DRILL_FILE = "eng-260-away-drill-w2.pdf"
const DRILL_MESSAGE = "ENG-260 away drill: please upload your outstanding March documents."

let app: CadenceApp | undefined

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

/** Cadence's own `.vendo/overrides.json`, handed to the registry exactly as the
 *  real composition hands it. Left out until now, which was invisible while
 *  extraction guessed grades from names: the catalog carried a `risk` for
 *  everything. Grades come from a person, the judge, or a protocol fact now
 *  (risk-grading redesign D2), so the file has to be here for the drill to see
 *  what the running app sees. */
async function cadenceOverrides(): Promise<Parameters<typeof createActions>[0]["overrides"]> {
  return JSON.parse(await readFile(join(appDir, ".vendo", "overrides.json"), "utf8")) as
    Parameters<typeof createActions>[0]["overrides"]
}

async function createStack(): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "cadence-away-drill-"))
  const store = createStore({ dataDir })
  await store.ensureSchema()
  const guard = createGuard({ store })
  const actions = createActions({
    tools: await cadenceTools(),
    overrides: await cadenceOverrides(),
    baseUrl: app!.origin,
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

/** One-step automation on the shared `cadence.docs-overdue` host event. Both
 *  step builders below write JSONata expressions: strings need quoting and a
 *  nested request body is a JSONata object constructor. */
function oneStepAutomation(id: string, name: string, step: Step): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name,
    trigger: {
      on: { kind: "host-event", event: "cadence.docs-overdue" },
      run: { kind: "steps", steps: [step] },
    },
  }
}

/** The drill's executing step: advance an overdue document to `received`. */
function intakeAutomation(id: string): AppDocument {
  return oneStepAutomation(id, "Document intake", {
    id: "intake",
    tool: INTAKE_TOOL,
    args: {
      id: `'${DOCUMENT.client}'`,
      docId: `'${DOCUMENT.id}'`,
      body: `{ 'action': 'receive', 'fileName': '${DRILL_FILE}' }`,
    },
  })
}

/** The step THE LAW must refuse: an automation messaging a human. */
function chaseAutomation(id: string): AppDocument {
  return oneStepAutomation(id, "Document chase", {
    id: "chase",
    tool: MESSAGE_TOOL,
    args: {
      id: `'${DOCUMENT.client}'`,
      body: `{ 'body': '${DRILL_MESSAGE}', 'author': 'Cadence Automations' }`,
    },
  })
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

async function enableAndApprove(stack: Stack, subject: string, doc: AppDocument): Promise<void> {
  const appId = doc.id
  const principal: Principal = { kind: "user", subject }
  await stack.store.records("vendo_apps").put({
    id: appId,
    data: { subject, enabled: false, doc },
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

/** Read Cadence's own API as `subject`, with a session minted the same way the
 *  away run's actAs mints one. This is the evidence channel, not the subject. */
async function readAs(subject: string, tool: string, path: string): Promise<Response> {
  const material = await supabasePreset({ secret: JWT_SECRET })(
    { kind: "user", subject },
    {
      id: "grt_evidence",
      subject,
      tool,
      descriptorHash: "sha256:evidence",
      scope: { kind: "tool" },
      duration: "session",
      source: "chat",
      grantedAt: new Date().toISOString(),
    },
  )
  return appFetch(`${app!.baseUrl}${path}`, { headers: material!.headers })
}

async function descriptorFor(stack: Stack, name: string): Promise<ToolDescriptor> {
  const found = (await stack.bound.descriptors({ venue: "chat", presence: "present" })).find(
    (descriptor) => descriptor.name === name,
  )
  expect(found, `${name} is not in Cadence's extracted toolset`).toBeDefined()
  return found!
}

beforeAll(async () => {
  app = await bootCadence(".next/away-drill", { SUPABASE_JWT_SECRET: JWT_SECRET })
}, BOOT_MS)

afterAll(async () => {
  await app?.stop()
})

describe("Cadence away drill (ENG-260)", () => {
  it("walls the firm API off behind the real login", { timeout: 120_000 }, async () => {
    const anonymous = await appFetch(`${app!.baseUrl}/api/clients/cl_rivera/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Nope" }),
    })
    expect(anonymous.status).toBe(401)

    // `baseUrl` IS the app root (origin + mount point) — a trailing slash on
    // top of it is a different URL, and Next answers it with its own 308 to the
    // canonical path instead of the login bounce this asserts.
    const page = await appFetch(app!.baseUrl, { redirect: "manual" })
    expect([302, 303, 307, 308]).toContain(page.status)
    expect(page.headers.get("location")).toContain("/cadence/login")
  })

  it("executes an automation as the granting user with no live session", { timeout: 120_000 }, async () => {
    const stack = await createStack()
    try {
      const subject = GRANTING_USER.subject
      const appId = "app_away_intake"

      // The drill's subject is the authority mechanic, so the tool it runs must
      // be one an automation may legally run unattended. Pin the declared label
      // (overrides.json — the dev's label is final), so relabelling or
      // repointing this step fails here loudly instead of silently turning
      // the drill into a law test.
      const intake = await descriptorFor(stack, INTAKE_TOOL)
      expect(intake.risk).toBe("write")

      await enableAndApprove(stack, subject, intakeAutomation(appId))

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
        { id: "intake", outcome: "ok" },
      ])

      // The side effect landed in Cadence as the granting user: read the
      // client's checklist back with a minted session for that user and find the
      // document the away run advanced.
      const checklist = await readAs(
        subject,
        "host_listClientDocuments",
        `/api/clients/${DOCUMENT.client}/documents`,
      )
      expect(checklist.status).toBe(200)
      const body = (await checklist.json()) as {
        data: Array<{ id: string; status: string; file?: { name: string } }>
      }
      const advanced = body.data.find((document) => document.id === DOCUMENT.id)
      expect(advanced?.status).toBe("received")
      expect(advanced?.file?.name).toBe(DRILL_FILE)
    } finally {
      await stack.close()
    }
  })

  /** THE LAW (design §12): automations "may **not** move money, message humans,
   *  or delete — those tools are not projected into an automation run at all.
   *  Not with a limit, not with a condition, not with an admin override." The
   *  drill above used to BE this step, and expected it to succeed; that
   *  expectation predates the law. Cadence's own `host_sendClientMessage` is a
   *  message to a human, so the honest pattern is prepare-then-a-person-sends. */
  it("refuses host_sendClientMessage in an unattended run — never projected, never sent (THE LAW, §12)", { timeout: 120_000 }, async () => {
    const stack = await createStack()
    try {
      const subject = GRANTING_USER.subject
      const appId = "app_away_chase"
      const send = await descriptorFor(stack, MESSAGE_TOOL)
      expect(send.risk).toBe("destructive")

      // Enable + approve while present: the ceremony sees the tool and mints the
      // strongest authority that exists (app-bound, automation-source). The law
      // must beat it.
      await enableAndApprove(stack, subject, chaseAutomation(appId))

      // 1. Not projected: an unattended run is never even offered the tool.
      const projected = await stack.bound.descriptors({
        venue: "automation",
        presence: "away",
      })
      expect(projected.map(({ name }) => name)).not.toContain(MESSAGE_TOOL)

      // 2. The run refuses with the law's own reason — the constant both sides
      //    read, so the test and the law cannot drift.
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
      expect(run?.status).toBe("error")
      expect(run?.steps.map(({ id, tool, outcome, detail }) => ({ id, tool, outcome, detail })))
        .toEqual([
          {
            id: "chase",
            tool: MESSAGE_TOOL,
            outcome: "blocked",
            detail: UNATTENDED_DESTRUCTIVE_REASON,
          },
        ])
      expect(run?.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON)

      // 3. It never executed: no such message exists in the client's thread.
      const thread = await readAs(
        subject,
        "host_listClientMessages",
        `/api/clients/${DOCUMENT.client}/messages`,
      )
      expect(thread.status).toBe(200)
      const messages = (await thread.json()) as { data: Array<{ body: string }> }
      expect(messages.data.map(({ body: text }) => text)).not.toContain(DRILL_MESSAGE)
    } finally {
      await stack.close()
    }
  })

  it("fails closed when the grant's subject is not a seeded Cadence user", { timeout: 120_000 }, async () => {
    const stack = await createStack()
    try {
      const subject = "1c9e6f2a-5d4b-4a3c-8b7e-0f1e2d3c4b5a"
      const appId = "app_away_ghost"
      await enableAndApprove(stack, subject, intakeAutomation(appId))
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

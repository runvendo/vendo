import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * STRUCTURAL INVARIANT — keep passing for ANY demo cloned from this template.
 *
 * The Cloud posture is the whole reason a generated demo has working
 * connections and state that survives a redeploy: the store and connections
 * slots must stay UNSET so one VENDO_API_KEY composes the hosted store and the
 * Cloud broker. It is also invisible at runtime until a prospect clicks
 * "connect" on a live demo, so a regression here is silent — hence a config
 * unit test rather than trust. The caps guard + spend middleware assertions
 * are the same kind of tripwire: the README forbids removing them, and an
 * un-metered demo on an open link is an unbounded bill.
 */

const createVendoSpy = vi.hoisted(() => vi.fn(() => ({ __mock: "vendo" })))
const vendoModelSpy = vi.hoisted(() => vi.fn((name?: string) => ({ __mock: "vendoModel", name })))
const createStoreSpy = vi.hoisted(() => vi.fn(() => ({ __mock: "localStore" })))
const wrapLanguageModelSpy = vi.hoisted(() =>
  vi.fn((options: unknown) => ({ __mock: "wrapped", ...(options as object) })),
)
const spendMiddlewareSpy = vi.hoisted(() =>
  vi.fn((_guard: unknown, modelId: string) => ({ __mock: "spendMiddleware", modelId })),
)
const capsGuardSpy = vi.hoisted(() => vi.fn(() => ({ __mock: "capsGuard" })))

vi.mock("@vendoai/vendo/server", () => ({ createVendo: createVendoSpy, vendoModel: vendoModelSpy }))
vi.mock("@vendoai/store", () => ({ createStore: createStoreSpy }))
vi.mock("ai", () => ({ wrapLanguageModel: wrapLanguageModelSpy }))
vi.mock("@/server/caps", () => ({
  getCapsGuard: capsGuardSpy,
  spendMeteringMiddleware: spendMiddlewareSpy,
}))

interface CapturedConfig {
  model?: { middleware?: { __mock?: string; modelId?: string }; model?: { name?: string } }
  store?: unknown
  connections?: unknown
  connectors?: unknown
  connectorApps?: string[]
}

/** Re-imports src/vendo/server under the current env and returns what it
 * passed to createVendo. resetModules is what makes the module-scope
 * composition re-run per case. */
async function composeServer(): Promise<CapturedConfig> {
  vi.resetModules()
  // Every spy, not just createVendo: the counts below are per module load.
  for (const spy of [createVendoSpy, vendoModelSpy, createStoreSpy, wrapLanguageModelSpy, spendMiddlewareSpy, capsGuardSpy]) {
    spy.mockClear()
  }
  await import("./server")
  expect(createVendoSpy).toHaveBeenCalledTimes(1)
  return createVendoSpy.mock.calls[0]![0] as CapturedConfig
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("DEMO_STORE", undefined)
  vi.stubEnv("VENDO_DEMO_MODEL", undefined)
})

afterEach(() => vi.unstubAllEnvs())

describe("demo-template vendo server posture", () => {
  it("deployed: leaves store + connections UNSET so VENDO_API_KEY composes the hosted store and Cloud broker", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test")

    const config = await composeServer()

    // Unset, not empty: an explicit store/connections/connectors value wins
    // over the key default (adapter rule), which is exactly what must NOT
    // happen on a deployed demo.
    expect(config.store).toBeUndefined()
    expect(config.connections).toBeUndefined()
    expect(config.connectors).toBeUndefined()
    expect(createStoreSpy).not.toHaveBeenCalled()
    // Scoped so the connect dock never advertises the console's full catalog.
    expect(config.connectorApps).toEqual(["gmail", "googlecalendar", "slack"])
  })

  it("local dev: DEMO_STORE=local pins the local PGlite store", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test")
    vi.stubEnv("DEMO_STORE", "local")

    const config = await composeServer()

    expect(createStoreSpy).toHaveBeenCalledWith({ dataDir: ".vendo/data" })
    expect(config.store).toEqual({ __mock: "localStore" })
    // The local pin is a STORE decision only — connections still ride the key.
    expect(config.connections).toBeUndefined()
  })

  it("keeps the caps guard + spend middleware wrapped around the model (README forbids removing them)", async () => {
    const config = await composeServer()

    expect(capsGuardSpy).toHaveBeenCalled()
    expect(wrapLanguageModelSpy).toHaveBeenCalledTimes(1)
    expect(config.model?.middleware).toMatchObject({ __mock: "spendMiddleware" })
    // The metered model IS the one handed to createVendo — a second unwrapped
    // model, or an unwrapped slot, would un-meter the demo.
    expect(config.model?.model).toMatchObject({ __mock: "vendoModel" })
  })

  it("rides the credential ladder by default and passes VENDO_DEMO_MODEL through verbatim", async () => {
    const unpinned = await composeServer()
    expect(vendoModelSpy).toHaveBeenLastCalledWith()
    expect(unpinned.model?.middleware?.modelId).toBe("vendo")

    vi.stubEnv("VENDO_DEMO_MODEL", "claude-sonnet-4-6")
    const pinned = await composeServer()
    expect(vendoModelSpy).toHaveBeenLastCalledWith("claude-sonnet-4-6")
    expect(pinned.model?.middleware?.modelId).toBe("claude-sonnet-4-6")
  })
})

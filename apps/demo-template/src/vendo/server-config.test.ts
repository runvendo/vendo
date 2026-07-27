import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * STRUCTURAL INVARIANT — keep passing for ANY demo cloned from this template.
 *
 * The Cloud posture is the whole reason a generated demo has working
 * connections and state that survives a redeploy: the store and connections
 * slots must stay UNSET so one VENDO_API_KEY composes the hosted store and the
 * Cloud broker. It is invisible at runtime until a prospect clicks "connect"
 * on a live demo, so a regression here is silent.
 *
 * Two layers, deliberately, because neither alone is enough:
 *
 *  - "composed posture" runs the REAL createVendo and inspects what it
 *    RESOLVED (`vendo.store`, `vendo.connections.posture`). Unset slots are
 *    necessary but not sufficient — what matters is which adapter actually
 *    came out the other side.
 *  - "wiring" mocks createVendo to assert the caps guard and spend middleware
 *    are still wrapped around the model. That one IS an argument check by
 *    nature: it is about what the host constructs and hands in, and the README
 *    forbids removing it (an unmetered demo on an open link is an unbounded
 *    bill).
 */

// ---------------------------------------------------------------------------
// Layer 1 — the real composition
// ---------------------------------------------------------------------------

/** The runtime's own hosted-store predicate (`isHostedStore` in
 * packages/vendo/src/server.ts), which is structural and not exported. */
function isHostedStore(store: unknown): boolean {
  const candidate = store as { sessions?: { register?: unknown }; erase?: { bySubject?: unknown } }
  return typeof candidate?.sessions?.register === "function"
    && typeof candidate?.erase?.bySubject === "function"
}

/** Re-imports src/vendo/server under the current env and returns the COMPOSED
 * server — the real adapters createVendo selected. */
async function composeReal(): Promise<{ store: unknown; connections: { posture: unknown } }> {
  vi.resetModules()
  const composed = await import("./server")
  return composed.vendo as unknown as { store: unknown; connections: { posture: unknown } }
}

describe("demo-template composed Cloud posture", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    // A provider key would win the model ladder and is irrelevant here; the
    // store and connections seams read VENDO_API_KEY only.
    vi.stubEnv("DEMO_STORE", undefined)
    vi.stubEnv("ANTHROPIC_API_KEY", undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("deployed: VENDO_API_KEY with no explicit slots RESOLVES the hosted store + Cloud connections", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test_posture")

    const vendo = await composeReal()

    // The adapter that actually composed — not merely "we passed nothing".
    expect(isHostedStore(vendo.store)).toBe(true)
    // ConnectionsService.posture is the runtime's own discriminator:
    // "cloud" (the broker) | "byo" (a passed connector) | false (unconfigured).
    expect(vendo.connections.posture).toBe("cloud")
  }, 60_000) // the umbrella's import graph costs seconds cold

  it("local dev: DEMO_STORE=local RESOLVES a local store, and does not disturb connections", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test_posture")
    vi.stubEnv("DEMO_STORE", "local")

    const vendo = await composeReal()

    expect(isHostedStore(vendo.store)).toBe(false)
    // The local pin is a STORE decision only — the key still buys the broker.
    expect(vendo.connections.posture).toBe("cloud")
  }, 60_000)

  it("keyless: composes neither, so a misconfigured demo fails loudly instead of half-working", async () => {
    vi.stubEnv("VENDO_API_KEY", undefined)

    const vendo = await composeReal()

    expect(isHostedStore(vendo.store)).toBe(false)
    expect(vendo.connections.posture).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Layer 2 — the wiring the README forbids removing
// ---------------------------------------------------------------------------

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

interface CapturedConfig {
  model?: { middleware?: { __mock?: string; modelId?: string }; model?: { name?: string } }
  store?: unknown
  connections?: unknown
  connectors?: unknown
  connectorApps?: string[]
}

describe("demo-template model wiring (caps guard + spend middleware)", () => {
  /** Mocks are applied per-test via doMock so the composed-posture suite above
   * keeps running the real umbrella. */
  async function composeMocked(): Promise<CapturedConfig> {
    vi.resetModules()
    for (const spy of [createVendoSpy, vendoModelSpy, createStoreSpy, wrapLanguageModelSpy, spendMiddlewareSpy, capsGuardSpy]) {
      spy.mockClear()
    }
    vi.doMock("@vendoai/vendo/server", () => ({ createVendo: createVendoSpy, vendoModel: vendoModelSpy }))
    vi.doMock("@vendoai/store", () => ({ createStore: createStoreSpy }))
    vi.doMock("ai", () => ({ wrapLanguageModel: wrapLanguageModelSpy }))
    vi.doMock("@/server/caps", () => ({ getCapsGuard: capsGuardSpy, spendMeteringMiddleware: spendMiddlewareSpy }))
    await import("./server")
    expect(createVendoSpy).toHaveBeenCalledTimes(1)
    return createVendoSpy.mock.calls[0]![0] as CapturedConfig
  }

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv("DEMO_STORE", undefined)
    vi.stubEnv("VENDO_DEMO_MODEL", undefined)
  })
  afterEach(() => {
    vi.doUnmock("@vendoai/vendo/server")
    vi.doUnmock("@vendoai/store")
    vi.doUnmock("ai")
    vi.doUnmock("@/server/caps")
    vi.unstubAllEnvs()
  })

  it("keeps the caps guard + spend middleware wrapped around the model", async () => {
    const config = await composeMocked()

    expect(capsGuardSpy).toHaveBeenCalled()
    expect(wrapLanguageModelSpy).toHaveBeenCalledTimes(1)
    expect(config.model?.middleware).toMatchObject({ __mock: "spendMiddleware" })
    // The metered model IS the one handed to createVendo — a second unwrapped
    // model, or an unwrapped slot, would un-meter the demo.
    expect(config.model?.model).toMatchObject({ __mock: "vendoModel" })
  })

  it("scopes the connect dock and leaves the key-composed slots unset", async () => {
    const config = await composeMocked()

    expect(config.store).toBeUndefined()
    expect(config.connections).toBeUndefined()
    expect(config.connectors).toBeUndefined()
    expect(config.connectorApps).toEqual(["gmail", "googlecalendar", "slack"])
  })

  it("rides the credential ladder by default and passes VENDO_DEMO_MODEL through verbatim", async () => {
    const unpinned = await composeMocked()
    expect(vendoModelSpy).toHaveBeenLastCalledWith()
    expect(unpinned.model?.middleware?.modelId).toBe("vendo")

    vi.stubEnv("VENDO_DEMO_MODEL", "claude-sonnet-4-6")
    const pinned = await composeMocked()
    expect(vendoModelSpy).toHaveBeenLastCalledWith("claude-sonnet-4-6")
    expect(pinned.model?.middleware?.modelId).toBe("claude-sonnet-4-6")
  })
})

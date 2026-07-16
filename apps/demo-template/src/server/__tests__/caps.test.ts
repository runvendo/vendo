import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { DemoConfig } from "@/lib/demo-config"
import {
  createCapsGuard,
  estimateTurnUsd,
  FALLBACK_TURN_ESTIMATE_USD,
  isAgentRunRequest,
  spendMeteringMiddleware,
} from "../caps"

const NOW = new Date("2026-07-16T12:00:00Z")

function makeConfig(overrides: Partial<DemoConfig> = {}): DemoConfig {
  return {
    id: "test-demo",
    prospect: "Test Demo",
    ctaUrl: "https://cal.com/yousefhelal",
    beats: [{ key: "generate-ui", prompt: "Show me a dashboard", chip: "Dashboard" }],
    caps: { maxTurns: 3, maxSpendUsd: 5 },
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  }
}

const tempDirs: string[] = []

function tempCountersPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "caps-test-"))
  tempDirs.push(dir)
  return path.join(dir, "demo-caps.json")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeGuard(config = makeConfig(), countersPath = tempCountersPath()) {
  return { guard: createCapsGuard({ config, countersPath, now: () => NOW }), countersPath }
}

describe("isAgentRunRequest", () => {
  it("matches only the message-submitting POST /api/vendo/threads", () => {
    expect(isAgentRunRequest("POST", "/api/vendo/threads")).toBe(true)
    // Polls/reads/subrequests are not turns.
    expect(isAgentRunRequest("GET", "/api/vendo/threads")).toBe(false)
    expect(isAgentRunRequest("GET", "/api/vendo/threads/t1")).toBe(false)
    expect(isAgentRunRequest("POST", "/api/vendo/approvals/decide")).toBe(false)
    expect(isAgentRunRequest("GET", "/api/vendo/status")).toBe(false)
    expect(isAgentRunRequest("DELETE", "/api/vendo/threads/t1")).toBe(false)
  })
})

describe("turn cap", () => {
  it("allows under-cap turns and increments the persisted counter", async () => {
    const { guard, countersPath } = makeGuard()
    expect(await guard.consumeTurn()).toBeNull()
    expect(await guard.consumeTurn()).toBeNull()
    const persisted = JSON.parse(readFileSync(countersPath, "utf8"))
    expect(persisted["test-demo"].turns).toBe(2)
  })

  it("allows the request that reaches maxTurns and refuses the next one", async () => {
    const { guard } = makeGuard(makeConfig({ caps: { maxTurns: 2, maxSpendUsd: 5 } }))
    expect(await guard.consumeTurn()).toBeNull()
    expect(await guard.consumeTurn()).toBeNull() // this turn reaches maxTurns — last allowed
    const refusal = await guard.consumeTurn()
    expect(refusal).not.toBeNull()
    expect(refusal!.status).toBe(429)
    expect(refusal!.body.vendoDemo.limit).toBe("turns")
  })

  it("serializes concurrent turns so interleaved requests cannot exceed the cap", async () => {
    const { guard, countersPath } = makeGuard(makeConfig({ caps: { maxTurns: 5, maxSpendUsd: 5 } }))
    const results = await Promise.all(Array.from({ length: 10 }, () => guard.consumeTurn()))
    expect(results.filter((r) => r === null)).toHaveLength(5)
    expect(results.filter((r) => r !== null)).toHaveLength(5)
    expect(JSON.parse(readFileSync(countersPath, "utf8"))["test-demo"].turns).toBe(5)
  })
})

describe("spend cap", () => {
  it("refuses once cumulative spend reaches maxSpendUsd", async () => {
    const { guard } = makeGuard()
    await guard.recordSpend(4.99)
    expect(await guard.consumeTurn()).toBeNull() // still under $5
    await guard.recordSpend(0.01) // now exactly at the cap
    const refusal = await guard.consumeTurn()
    expect(refusal).not.toBeNull()
    expect(refusal!.status).toBe(429)
    expect(refusal!.body.vendoDemo.limit).toBe("spend")
  })
})

describe("expiry", () => {
  it("refuses all agent traffic with 410 and limit expired", async () => {
    const { guard } = makeGuard(makeConfig({ expiresAt: "2026-01-01T00:00:00.000Z" }))
    const refusal = guard.refuseIfExpired()
    expect(refusal).not.toBeNull()
    expect(refusal!.status).toBe(410)
    expect(refusal!.body.vendoDemo.limit).toBe("expired")
    // consumeTurn also refuses (and never increments) when expired.
    const turnRefusal = await guard.consumeTurn()
    expect(turnRefusal!.status).toBe(410)
    expect(turnRefusal!.body.vendoDemo.limit).toBe("expired")
  })

  it("returns null while the demo has not expired", () => {
    const { guard } = makeGuard()
    expect(guard.refuseIfExpired()).toBeNull()
  })
})

describe("peekRefusal", () => {
  it("never consumes a turn", async () => {
    const { guard, countersPath } = makeGuard(makeConfig({ caps: { maxTurns: 2, maxSpendUsd: 5 } }))
    expect(await guard.peekRefusal()).toBeNull()
    expect(await guard.peekRefusal()).toBeNull()
    expect(await guard.consumeTurn()).toBeNull() // peeks left both turns available
    expect(JSON.parse(readFileSync(countersPath, "utf8"))["test-demo"].turns).toBe(1)
  })

  it("mirrors the turn refusal once the cap is exhausted", async () => {
    const { guard } = makeGuard(makeConfig({ caps: { maxTurns: 1, maxSpendUsd: 5 } }))
    await guard.consumeTurn()
    const refusal = await guard.peekRefusal()
    expect(refusal!.status).toBe(429)
    expect(refusal!.body.vendoDemo.limit).toBe("turns")
  })

  it("mirrors the spend refusal once cumulative spend reaches the cap", async () => {
    const { guard } = makeGuard()
    await guard.recordSpend(5)
    const refusal = await guard.peekRefusal()
    expect(refusal!.status).toBe(429)
    expect(refusal!.body.vendoDemo.limit).toBe("spend")
  })

  it("reports expiry with 410", async () => {
    const { guard } = makeGuard(makeConfig({ expiresAt: "2026-01-01T00:00:00.000Z" }))
    const refusal = await guard.peekRefusal()
    expect(refusal!.status).toBe(410)
    expect(refusal!.body.vendoDemo.limit).toBe("expired")
  })
})

describe("refusal body shape", () => {
  it("carries a stable machine-readable vendoDemo body with the config ctaUrl", async () => {
    const { guard } = makeGuard(makeConfig({ caps: { maxTurns: 1, maxSpendUsd: 5 } }))
    await guard.consumeTurn()
    const refusal = await guard.consumeTurn()
    expect(refusal!.body).toEqual({
      vendoDemo: {
        limit: "turns",
        message: expect.stringContaining("book a call"),
        ctaUrl: "https://cal.com/yousefhelal",
      },
    })
  })
})

describe("persistence", () => {
  it("survives a restart: a new guard instance continues from the persisted counters", async () => {
    const countersPath = tempCountersPath()
    const config = makeConfig({ caps: { maxTurns: 2, maxSpendUsd: 5 } })
    const first = createCapsGuard({ config, countersPath, now: () => NOW })
    expect(await first.consumeTurn()).toBeNull()
    expect(await first.consumeTurn()).toBeNull()
    // Simulated restart: fresh guard, same file.
    const second = createCapsGuard({ config, countersPath, now: () => NOW })
    const refusal = await second.consumeTurn()
    expect(refusal!.body.vendoDemo.limit).toBe("turns")
  })

  it("treats a missing counters file as a fresh start (deleting it resets the demo)", async () => {
    const countersPath = tempCountersPath()
    const config = makeConfig({ caps: { maxTurns: 1, maxSpendUsd: 5 } })
    const first = createCapsGuard({ config, countersPath, now: () => NOW })
    expect(await first.consumeTurn()).toBeNull()
    expect((await first.consumeTurn())!.body.vendoDemo.limit).toBe("turns")
    rmSync(countersPath)
    const second = createCapsGuard({ config, countersPath, now: () => NOW })
    expect(await second.consumeTurn()).toBeNull()
  })
})

describe("fail closed", () => {
  it("refuses agent traffic when the counters file is corrupt", async () => {
    const countersPath = tempCountersPath()
    writeFileSync(countersPath, "{not json!!", "utf8")
    const { guard } = makeGuard(makeConfig(), countersPath)
    const refusal = await guard.consumeTurn()
    expect(refusal).not.toBeNull()
    expect(refusal!.status).toBe(429)
  })

  it("refuses when the counters file has a valid-JSON but wrong-shape payload", async () => {
    const countersPath = tempCountersPath()
    writeFileSync(countersPath, JSON.stringify({ "test-demo": { turns: "lots" } }), "utf8")
    const { guard } = makeGuard(makeConfig(), countersPath)
    expect(await guard.consumeTurn()).not.toBeNull()
  })

  it("never overwrites a corrupt counters file (the poison stays for inspection)", async () => {
    const countersPath = tempCountersPath()
    writeFileSync(countersPath, "{not json!!", "utf8")
    const { guard } = makeGuard(makeConfig(), countersPath)
    await guard.consumeTurn()
    await guard.recordSpend(1)
    expect(readFileSync(countersPath, "utf8")).toBe("{not json!!")
  })
})

describe("spend estimation", () => {
  it("prices known models from the per-model table", () => {
    // 1M input at $3/MTok + 100k output at $15/MTok = 3 + 1.5
    const usd = estimateTurnUsd("claude-sonnet-4-6", {
      inputTokens: { total: 1_000_000, cacheWrite: 0 },
      outputTokens: { total: 100_000 },
    })
    expect(usd).toBeCloseTo(4.5)
  })

  it("prices unknown models at the documented conservative fallback rate", () => {
    const usd = estimateTurnUsd("some-future-model", {
      inputTokens: { total: 1_000_000, cacheWrite: 0 },
      outputTokens: { total: 0 },
    })
    expect(usd).toBeCloseTo(10) // fallback input rate $10/MTok
  })

  it("falls back to the conservative per-turn constant when usage is unreported", () => {
    const usd = estimateTurnUsd("claude-sonnet-4-6", {
      inputTokens: { total: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined },
    })
    expect(usd).toBe(FALLBACK_TURN_ESTIMATE_USD)
  })
})

describe("spendMeteringMiddleware", () => {
  it("records real usage from the stream's finish part", async () => {
    const { guard, countersPath } = makeGuard()
    const middleware = spendMeteringMiddleware(guard, "claude-sonnet-4-6")
    const parts = [
      { type: "text-delta", id: "1", delta: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
        },
      },
    ]
    const doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      }),
    })
    const { stream } = await middleware.wrapStream!({
      doStream: doStream as never,
      doGenerate: undefined as never,
      params: {} as never,
      model: {} as never,
    })
    // Drain the wrapped stream; the tap must pass every part through untouched.
    const reader = (stream as ReadableStream).getReader()
    const seen: unknown[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(value)
    }
    expect(seen).toEqual(parts)
    const persisted = JSON.parse(readFileSync(countersPath, "utf8"))
    expect(persisted["test-demo"].spendUsd).toBeCloseTo(4.5)
  })

  it("records real usage from a non-streaming doGenerate result", async () => {
    const { guard, countersPath } = makeGuard()
    const middleware = spendMeteringMiddleware(guard, "claude-sonnet-4-6")
    const generated = {
      content: [{ type: "text", text: "hi" }],
      finishReason: "stop",
      usage: {
        inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
      },
    }
    const result = await middleware.wrapGenerate!({
      doGenerate: (async () => generated) as never,
      doStream: undefined as never,
      params: {} as never,
      model: {} as never,
    })
    // The result must pass through untouched.
    expect(result).toEqual(generated)
    const persisted = JSON.parse(readFileSync(countersPath, "utf8"))
    expect(persisted["test-demo"].spendUsd).toBeCloseTo(4.5)
  })

  it("charges the conservative fallback when a doGenerate result reports no usage", async () => {
    const { guard, countersPath } = makeGuard()
    const middleware = spendMeteringMiddleware(guard, "claude-sonnet-4-6")
    const generated = {
      content: [{ type: "text", text: "hi" }],
      finishReason: "stop",
      usage: {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
    }
    await middleware.wrapGenerate!({
      doGenerate: (async () => generated) as never,
      doStream: undefined as never,
      params: {} as never,
      model: {} as never,
    })
    const persisted = JSON.parse(readFileSync(countersPath, "utf8"))
    expect(persisted["test-demo"].spendUsd).toBe(FALLBACK_TURN_ESTIMATE_USD)
  })
})

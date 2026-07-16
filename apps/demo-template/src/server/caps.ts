import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LanguageModelMiddleware } from "ai"
import { isExpired, type DemoConfig } from "@/lib/demo-config"
import { loadDemoConfig } from "@/lib/demo-config-loader"

/**
 * Caps guard — the ONLY thing bounding cost/abuse on a deployed demo, which is
 * an OPEN link running on our Anthropic key. Three caps, all from demo.config:
 *
 *  - turns:   POST /api/vendo/threads (the message-submitting request) is one
 *             "turn"; once `caps.maxTurns` turns are consumed, further runs
 *             are refused with 429.
 *  - spend:   REAL token usage, observed via ai-SDK model middleware
 *             ({@link spendMeteringMiddleware}) and priced by a per-model
 *             table; cumulative USD >= `caps.maxSpendUsd` refuses runs (429).
 *  - expired: past `expiresAt`, ALL /api/vendo traffic is refused (410) while
 *             visible pages still render.
 *
 * Counters persist in an atomic JSON file under .vendo/data/ (gitignored) so
 * they survive process restarts; deleting the file resets the demo. FAIL
 * CLOSED: an unreadable/corrupt counters file refuses agent traffic instead
 * of allowing unmetered use, and is never overwritten (the poison stays on
 * disk for inspection). Single-instance semantics — one Railway service per
 * demo — with an in-process queue serializing counter mutations.
 */

export type CapsLimit = "turns" | "spend" | "expired"

export interface CapsRefusal {
  status: 429 | 410
  body: { vendoDemo: { limit: CapsLimit; message: string; ctaUrl: string } }
}

export interface CapsGuard {
  /** 410 refusal when the demo is past `expiresAt`, else null. Pure — no counter I/O. */
  refuseIfExpired(): CapsRefusal | null
  /**
   * Gate one agent run. Returns a refusal (expired/turns/spend/fail-closed)
   * or, when allowed, consumes one turn and returns null.
   */
  consumeTurn(): Promise<CapsRefusal | null>
  /** Add estimated USD to the demo's cumulative spend counter. */
  recordSpend(usd: number): Promise<void>
}

/**
 * A "turn" = the one wire route that starts/continues an agent run:
 * POST {BASE_PATH}/threads, the only endpoint that calls deps.agent.stream in
 * packages/vendo/src/server.ts. Everything else the panel sends (GET thread
 * polls, approvals, grants, status, app reads) is a subrequest, not a turn.
 * The other LLM-invoking wire routes (POST /apps create, POST /apps/:id/edit)
 * are not counted as turns, but their token spend IS metered — the spend
 * middleware wraps the model itself, so every LLM call lands on the spend cap.
 */
export function isAgentRunRequest(method: string, pathname: string): boolean {
  return method === "POST" && pathname === "/api/vendo/threads"
}

const LIMIT_MESSAGE = "This demo has reached its limit — book a call to see the real thing."
const EXPIRED_MESSAGE = "This demo has expired — book a call to see the real thing."

/**
 * $ per 1M tokens (platform.claude.com/docs/en/pricing, checked 2026-07-16).
 * Cache-write tokens bill at 1.25x input, so the estimator adds a 0.25x
 * surcharge on the cacheWrite portion; cache reads are priced at the FULL
 * input rate (actual is ~0.1x) — deliberately conservative, this guard
 * over-counts rather than under-counts.
 */
const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-8": { input: 5, output: 25 },
}

/** Unknown models price at the most expensive current tier (Fable 5) — conservative. */
const FALLBACK_PRICE_USD_PER_MTOK = { input: 10, output: 50 }

/**
 * Charged when a stream ends without reporting usage (provider anomaly) so a
 * turn never goes fully unmetered. Roughly a heavy demo turn at sonnet rates.
 */
export const FALLBACK_TURN_ESTIMATE_USD = 0.15

export interface TurnUsage {
  inputTokens: { total: number | undefined; cacheWrite: number | undefined }
  outputTokens: { total: number | undefined }
}

export function estimateTurnUsd(modelId: string, usage: TurnUsage): number {
  if (usage.inputTokens.total === undefined && usage.outputTokens.total === undefined) {
    return FALLBACK_TURN_ESTIMATE_USD
  }
  const price = MODEL_PRICES_USD_PER_MTOK[modelId] ?? FALLBACK_PRICE_USD_PER_MTOK
  return (
    ((usage.inputTokens.total ?? 0) / 1e6) * price.input +
    ((usage.inputTokens.cacheWrite ?? 0) / 1e6) * price.input * 0.25 +
    ((usage.outputTokens.total ?? 0) / 1e6) * price.output
  )
}

/** Per-demo counters as persisted: { [demoId]: { turns, spendUsd } }. */
type CountersFile = Record<string, { turns: number; spendUsd: number }>

function isValidCountersFile(value: unknown): value is CountersFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      Number.isFinite((entry as { turns?: unknown }).turns) &&
      Number.isFinite((entry as { spendUsd?: unknown }).spendUsd),
  )
}

export function createCapsGuard(options: {
  config: DemoConfig
  countersPath: string
  now?: () => Date
}): CapsGuard {
  const { config, countersPath } = options
  const now = options.now ?? (() => new Date())

  // Missing file => fresh counters (deleting the file resets the demo).
  // Unreadable/unparseable/wrong shape => "corrupt": fail closed and never write.
  function load(): { counters: CountersFile } | { corrupt: true } {
    let raw: string
    try {
      raw = readFileSync(countersPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { counters: {} }
      return { corrupt: true }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isValidCountersFile(parsed)) return { corrupt: true }
      return { counters: parsed }
    } catch {
      return { corrupt: true }
    }
  }

  // Atomic write: temp file + rename, so a crash mid-write can't corrupt counters.
  function save(counters: CountersFile): void {
    mkdirSync(path.dirname(countersPath), { recursive: true })
    const temporary = `${countersPath}.tmp`
    writeFileSync(temporary, JSON.stringify(counters, null, 2), "utf8")
    renameSync(temporary, countersPath)
  }

  const refusal = (limit: CapsLimit): CapsRefusal => ({
    status: limit === "expired" ? 410 : 429,
    body: {
      vendoDemo: {
        limit,
        message: limit === "expired" ? EXPIRED_MESSAGE : LIMIT_MESSAGE,
        ctaUrl: config.ctaUrl,
      },
    },
  })

  // In-process serialization: one Node instance per demo, so a promise chain
  // is sufficient to keep interleaved requests from clobbering the file.
  let queue: Promise<unknown> = Promise.resolve()
  function serialized<T>(op: () => T): Promise<T> {
    const next = queue.then(op)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    refuseIfExpired() {
      return isExpired(config, now()) ? refusal("expired") : null
    },

    consumeTurn() {
      return serialized(() => {
        if (isExpired(config, now())) return refusal("expired")
        const state = load()
        if ("corrupt" in state) {
          console.error(`[caps] counters file at "${countersPath}" is corrupt — failing closed`)
          return refusal("turns")
        }
        const entry = state.counters[config.id] ?? { turns: 0, spendUsd: 0 }
        if (entry.turns >= config.caps.maxTurns) return refusal("turns")
        if (entry.spendUsd >= config.caps.maxSpendUsd) return refusal("spend")
        state.counters[config.id] = { ...entry, turns: entry.turns + 1 }
        save(state.counters)
        return null
      })
    },

    recordSpend(usd: number) {
      return serialized(() => {
        const state = load()
        // Corrupt file: do NOT overwrite it with fresh counters — that would
        // silently undo the fail-closed gate. Leave the poison in place.
        if ("corrupt" in state) {
          console.error(`[caps] counters file at "${countersPath}" is corrupt — spend not recorded`)
          return
        }
        const entry = state.counters[config.id] ?? { turns: 0, spendUsd: 0 }
        state.counters[config.id] = { ...entry, spendUsd: entry.spendUsd + usd }
        save(state.counters)
      })
    },
  }
}

/**
 * ai-SDK model middleware that observes REAL token usage from each provider
 * stream's `finish` part and records it as spend. createVendo exposes no
 * usage callback, but the host constructs the LanguageModel itself, so
 * wrapping it (`wrapLanguageModel`) is an honest seam: every LLM call — chat
 * turns, app create/edit — flows through here. Pass-through tap; parts are
 * never altered.
 */
export function spendMeteringMiddleware(guard: CapsGuard, modelId: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      let recordedUsd = 0
      const tap = new TransformStream<unknown, unknown>({
        transform(part, controller) {
          const candidate = part as { type?: string; usage?: TurnUsage }
          if (candidate.type === "finish" && candidate.usage !== undefined) {
            recordedUsd += estimateTurnUsd(modelId, candidate.usage)
          }
          controller.enqueue(part)
        },
        async flush() {
          // A stream that ends without a finish part still burned tokens we
          // couldn't see — charge the conservative per-turn fallback.
          const usd = recordedUsd > 0 ? recordedUsd : FALLBACK_TURN_ESTIMATE_USD
          await guard.recordSpend(usd).catch((error) => {
            console.error("[caps] failed to record spend:", error)
          })
        },
      })
      return { ...result, stream: result.stream.pipeThrough(tap) as never }
    },
  }
}

/** Where counters live; already gitignored alongside the Vendo store's data. */
const COUNTERS_PATH = path.join(process.cwd(), ".vendo/data/demo-caps.json")

let singleton: CapsGuard | undefined

/**
 * The app-wide guard, wired to demo.config.json and .vendo/data. Loading the
 * config throws loudly on a broken file, which (as a 500) still refuses agent
 * traffic — fail closed either way.
 *
 * TEST KNOB: DEMO_CAPS_MAX_TURNS overrides caps.maxTurns at runtime so live
 * verification can exhaust a tiny cap without committing a changed
 * demo.config.json. Never set it on a deployed demo.
 */
export function getCapsGuard(): CapsGuard {
  if (singleton === undefined) {
    const config = loadDemoConfig()
    const override = Number(process.env.DEMO_CAPS_MAX_TURNS)
    const caps =
      Number.isInteger(override) && override > 0 ? { ...config.caps, maxTurns: override } : config.caps
    singleton = createCapsGuard({ config: { ...config, caps }, countersPath: COUNTERS_PATH })
  }
  return singleton
}

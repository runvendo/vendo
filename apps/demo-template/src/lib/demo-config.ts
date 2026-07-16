import { z } from "zod"

/**
 * demo.config.json's shape — the single source of truth for one generated
 * demo. Consumed by: this app's chrome (suggestion chips + caps guard) and
 * the bench/ GIF-capture harness. This module depends on zod only and is
 * genuinely fs-free, so it's safe to import from client components. Disk
 * access (`loadDemoConfig`) lives in `./demo-config-loader`, which is
 * server/bench-only.
 */

/** Lowercase alphanumeric segments joined by single hyphens, e.g. "acme-widgets". No leading/trailing/double hyphens. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

const slugSchema = z.string().regex(SLUG_PATTERN, "must be lowercase alphanumeric with hyphens")

/** One beat of the fixed 3-beat demo arc: generate branded UI, take a real action with consent, save as a reusable app. */
export const demoBeatSchema = z
  .object({
    key: slugSchema,
    /** The message typed into the Vendo panel to play this beat. */
    prompt: z.string().min(1, "must be non-empty"),
    /** Short label shown as a suggestion chip. */
    chip: z.string().min(1, "must be non-empty"),
  })
  .strict()

export type DemoBeat = z.infer<typeof demoBeatSchema>

/** Per-demo agent-usage limits. */
export const demoCapsSchema = z
  .object({
    maxTurns: z.number().int().positive("must be a positive integer"),
    maxSpendUsd: z.number().positive("must be a positive number"),
  })
  .strict()

export type DemoCaps = z.infer<typeof demoCapsSchema>

/**
 * demo.config.json's shape. Strict everywhere: a typo or stray field in a
 * hand-edited (or agent-authored) config must fail loudly, never be silently
 * dropped. `expiresAt` is validated for FORMAT only — a config whose
 * `expiresAt` is already in the past still parses so the app can boot and
 * show a friendly "demo expired" state; enforcement lives in the caps guard,
 * which calls {@link isExpired}. Format is UTC-only (zod's `datetime()`
 * default): a "Z"-terminated instant, deterministic for generated configs —
 * offset timestamps like `+02:00` are rejected, not normalized.
 */
export const demoConfigSchema = z
  .object({
    /** Registry key and thread-id derivation. */
    id: slugSchema,
    /** Display name of the prospect company. */
    prospect: z.string().min(1, "must be non-empty"),
    /** Booking link shown in demo chrome. */
    ctaUrl: z.string().url("must be a valid URL"),
    beats: z.array(demoBeatSchema).min(1, "must be a non-empty array"),
    caps: demoCapsSchema,
    expiresAt: z.string().datetime({
      message: 'must be a UTC ISO-8601 date-time ending in "Z" (e.g. 2026-01-01T00:00:00Z)',
    }),
  })
  .strict()

export type DemoConfig = z.infer<typeof demoConfigSchema>

const formatZodError = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ")

/**
 * Validates a parsed JSON value against {@link demoConfigSchema}, throwing a
 * single Error whose message names every offending field so malformed
 * configs fail loudly instead of silently coercing. `source` labels the
 * error prefix (defaults to "demo config") so callers like the loader can
 * fold in a file path without double-wrapping the message.
 */
export function parseDemoConfig(input: unknown, source = "demo config"): DemoConfig {
  const result = demoConfigSchema.safeParse(input)
  if (!result.success) {
    throw new Error(`invalid ${source}: ${formatZodError(result.error)}`)
  }
  return result.data
}

/**
 * Pure expiry check — `now` is explicit so callers (and tests) don't depend
 * on wall-clock time. A demo is expired at or after its `expiresAt` instant.
 */
export function isExpired(config: Pick<DemoConfig, "expiresAt">, now: Date): boolean {
  return now.getTime() >= new Date(config.expiresAt).getTime()
}

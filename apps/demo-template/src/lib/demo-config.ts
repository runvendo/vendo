import { readFileSync } from "node:fs"
import path from "node:path"
import { safeErrorMessage } from "@vendoai/core"
import { z } from "zod"

/**
 * demo.config.json — the single source of truth for one generated demo.
 * Consumed by: this app's chrome (suggestion chips + caps guard) and the
 * bench/ GIF-capture harness, so the schema stays a plain, fs-free module —
 * only `loadDemoConfig` touches disk.
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
 * which calls {@link isExpired}.
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
    expiresAt: z.string().datetime({ message: "must be an ISO-8601 date-time string" }),
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
 * configs fail loudly instead of silently coercing.
 */
export function parseDemoConfig(input: unknown): DemoConfig {
  const result = demoConfigSchema.safeParse(input)
  if (!result.success) {
    throw new Error(`invalid demo config: ${formatZodError(result.error)}`)
  }
  return result.data
}

/**
 * Reads and validates a demo.config.json file. Defaults to the app root
 * (process.cwd()/demo.config.json). Node `fs` only — safe to call from
 * server-side code (route handlers, the bench capture harness) but never
 * from client components.
 */
export function loadDemoConfig(
  configPath: string = path.join(process.cwd(), "demo.config.json"),
): DemoConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (error) {
    throw new Error(`could not read demo config at "${configPath}": ${safeErrorMessage(error)}`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`demo config at "${configPath}" is not valid JSON: ${safeErrorMessage(error)}`)
  }

  try {
    return parseDemoConfig(json)
  } catch (error) {
    throw new Error(`demo config at "${configPath}" is invalid: ${safeErrorMessage(error)}`)
  }
}

/**
 * Pure expiry check — `now` is explicit so callers (and tests) don't depend
 * on wall-clock time. A demo is expired at or after its `expiresAt` instant.
 */
export function isExpired(config: Pick<DemoConfig, "expiresAt">, now: Date): boolean {
  return now.getTime() >= new Date(config.expiresAt).getTime()
}

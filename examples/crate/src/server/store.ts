import { buildSeed, type SeedData } from "./seed"

/**
 * The singleton has to hang off `globalThis`, not a module-level `let`.
 *
 * Next bundles route handlers and server components separately, so a plain
 * module variable is instantiated once per bundle: a refund posted through
 * /api/refunds landed in one copy of the store while /orders/[id] kept
 * rendering the other, and the page showed "Paid" for an order the API called
 * "refunded". Same trick as the usual Prisma-client-in-dev pattern, and it also
 * survives hot reload.
 */
const KEY = Symbol.for("crate.store")

type Globals = typeof globalThis & { [KEY]?: SeedData }

export function getStore(): SeedData {
  const globals = globalThis as Globals
  if (!globals[KEY]) globals[KEY] = buildSeed(new Date())
  return globals[KEY]
}

/**
 * Reseed lever. Tests pass a fixed anchor for deterministic assertions; the
 * demo reset route calls it to put the story back after someone has refunded
 * their way through it.
 */
export function __reseed(anchor: Date): SeedData {
  const globals = globalThis as Globals
  globals[KEY] = buildSeed(anchor)
  return globals[KEY]
}

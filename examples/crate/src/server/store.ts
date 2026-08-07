import { buildSeed, type SeedData } from "./seed"

// Module singleton — seeded once per server process at first import.
let cache: SeedData | null = null

export function getStore(): SeedData {
  if (!cache) cache = buildSeed(new Date())
  return cache
}

/**
 * Reseed lever. Tests pass a fixed anchor for deterministic assertions; the
 * demo reset route calls it to put the story back after someone has refunded
 * their way through it.
 */
export function __reseed(anchor: Date): SeedData {
  cache = buildSeed(anchor)
  return cache
}

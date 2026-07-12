import { buildSeed, type SeedData } from "./seed"

// Module singleton — seeded once per server process at first import.
let cache: SeedData | null = null

export function getStore(): SeedData {
  if (!cache) cache = buildSeed(new Date())
  return cache
}

// Test helper: reseed with a fixed anchor for deterministic assertions.
export function __reseed(anchor: Date): SeedData {
  cache = buildSeed(anchor); return cache
}

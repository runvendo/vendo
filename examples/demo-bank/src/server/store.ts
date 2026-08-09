import { buildSeed, type MapleScenario, type SeedData } from "./seed"

// Module singleton — seeded once per server process at first import.
let cache: SeedData | null = null

export function getStore(): SeedData {
  if (!cache) cache = buildSeed(new Date())
  return cache
}

// Reseed lever: tests pass a fixed anchor for deterministic assertions; the
// demo reset route passes a scenario to stage a specific story (reseeding
// erases the in-memory bank state, so a scripted demo runs it FIRST).
export function __reseed(anchor: Date, scenario?: MapleScenario): SeedData {
  cache = buildSeed(anchor, scenario); return cache
}

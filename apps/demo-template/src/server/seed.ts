import { mulberry32 } from "./prng"
import type { Item } from "./types"

export interface SeedData {
  items: Item[]
}

// Deliberately generic names — the creator replaces these with the prospect's
// real-sounding domain records (see src/server/types.ts).
const NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
  "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima",
]

function daysAgo(anchor: Date, n: number, h: number, m: number) {
  const d = new Date(anchor); d.setDate(d.getDate() - n); d.setHours(h, m, 0, 0); return d
}

export function buildSeed(anchor: Date = new Date()): SeedData {
  const rand = mulberry32(20260716)

  const items: Item[] = NAMES.map((name, i) => ({
    id: `item_${String(i + 1).padStart(3, "0")}`,
    name,
    // Mostly active with a few archived, so both states exist on first load.
    status: rand() < 0.25 ? "archived" : "active",
    amount: 500 + Math.floor(rand() * 95000),
    updatedAt: daysAgo(anchor, 1 + Math.floor(rand() * 60), 8 + Math.floor(rand() * 10), Math.floor(rand() * 60)).toISOString(),
  }))

  items.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
  return { items }
}

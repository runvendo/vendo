import { describe, it, expect } from "vitest"
import { buildSeed } from "../seed"

const anchor = new Date("2026-07-16T12:00:00-07:00")

// Structural invariant — keep for every demo cloned from this template: the
// seed must stay deterministic (same anchor, identical data) whatever domain
// entities replace the sample `items`.
describe("buildSeed invariants (keep for every demo)", () => {
  it("is deterministic — same anchor produces identical seed data", () => {
    expect(buildSeed(anchor)).toEqual(buildSeed(anchor))
  })
})

// DELETE OR REWRITE when creating a demo from this template — these pin the
// sample `items` entity (item_ ids, active/archived statuses). Rewrite them
// against the prospect-domain entities that replace src/server/seed.ts.
describe("template-sample seed content (DELETE OR REWRITE on clone)", () => {
  it("seeds a believable list with both statuses", () => {
    const { items } = buildSeed(anchor)
    expect(items.length).toBeGreaterThanOrEqual(8)
    const statuses = new Set(items.map((i) => i.status))
    expect(statuses.has("active")).toBe(true)
    expect(statuses.has("archived")).toBe(true)
    for (const item of items) {
      expect(item.id).toMatch(/^item_/)
      expect(item.name.length).toBeGreaterThan(0)
      expect(Number.isInteger(item.amount)).toBe(true)
      expect(new Date(item.updatedAt).getTime()).not.toBeNaN()
    }
  })

  it("sorts items most recently updated first", () => {
    const { items } = buildSeed(anchor)
    const times = items.map((i) => +new Date(i.updatedAt))
    expect(times).toEqual([...times].sort((x, y) => y - x))
  })
})

import { describe, expect, it } from "vitest"
import { buildSeed } from "./seed"

describe("seed date serialization", () => {
  it("filing deadlines keep the intended local calendar date in the serialized string", () => {
    const seed = buildSeed()
    for (const c of seed.clients) {
      if (!c.filingDeadline) continue
      // The date part of the serialized string must equal the local calendar
      // date of the moment it denotes (5pm local) — toISOString() broke this
      // by shifting evening times to the next UTC day.
      const d = new Date(c.filingDeadline)
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      expect(c.filingDeadline.slice(0, 10)).toBe(local)
    }
  })
})

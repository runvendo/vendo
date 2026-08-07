import { describe, it, expect } from "vitest"
import { mulberry32 } from "../prng"

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42); const b = mulberry32(42)
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })
  it("returns values in [0,1)", () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
})

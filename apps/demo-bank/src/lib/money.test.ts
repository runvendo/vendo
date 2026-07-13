import { describe, it, expect } from "vitest"
import { formatUSD, formatAmount } from "./money"

describe("money", () => {
  it("formats absolute amounts", () => {
    expect(formatUSD(8700)).toBe("$87.00")
    expect(formatUSD(123456)).toBe("$1,234.56")
    expect(formatUSD(0)).toBe("$0.00")
    expect(formatUSD(-8700)).toBe("$87.00")
  })
  it("formats signed amounts for transactions", () => {
    expect(formatAmount(-8700)).toBe("-$87.00")
    expect(formatAmount(120000)).toBe("+$1,200.00")
    expect(formatAmount(0)).toBe("$0.00")
  })
})

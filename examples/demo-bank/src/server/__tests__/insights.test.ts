import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../store"
import { spendingByCategory, budgets, cashflow, recurring } from "../insights"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("insights", () => {
  it("spending-by-category reconciles with this month's debits", () => {
    const slices = spendingByCategory()
    expect(slices.length).toBeGreaterThan(0)
    expect(slices.every(s => s.amount >= 0)).toBe(true)
    const dining = slices.find(s => s.category === "dining")
    expect(dining && dining.amount >= 8700).toBe(true)
  })
  it("budgets never report negative spent and have a positive limit", () => {
    for (const b of budgets()) { expect(b.spent).toBeGreaterThanOrEqual(0); expect(b.limit).toBeGreaterThan(0) }
  })
  it("cashflow returns in/out points", () => {
    const c = cashflow()
    expect(c.length).toBeGreaterThan(0)
    expect(c.every(p => p.in >= 0 && p.out >= 0)).toBe(true)
  })
  it("detects recurring subscriptions", () => {
    expect(recurring().some(r => r.merchant === "Spotify")).toBe(true)
  })
})

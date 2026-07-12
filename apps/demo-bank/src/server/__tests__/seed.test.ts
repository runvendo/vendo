import { describe, it, expect } from "vitest"
import { buildSeed } from "../seed"

const anchor = new Date("2026-06-29T12:00:00-07:00")

describe("buildSeed", () => {
  const data = buildSeed(anchor)

  it("creates four accounts including checking and savings", () => {
    const kinds = data.accounts.map(a => a.kind)
    expect(kinds).toContain("checking")
    expect(kinds).toContain("savings")
    expect(data.accounts.length).toBe(4)
  })

  it("generates a substantial, deterministic transaction history", () => {
    const a = buildSeed(anchor); const b = buildSeed(anchor)
    expect(a.transactions.length).toBeGreaterThanOrEqual(120)
    expect(a.transactions.map(t => t.id)).toEqual(b.transactions.map(t => t.id))
  })

  it("plants the $87 DoorDash charge at 1:14 AM on checking", () => {
    const dd = data.transactions.find(t => t.merchant === "DoorDash" && t.amount === -8700)
    expect(dd).toBeTruthy()
    const checking = data.accounts.find(a => a.kind === "checking")!
    expect(dd!.accountId).toBe(checking.id)
    expect(dd!.category).toBe("dining")
    const d = new Date(dd!.timestamp)
    expect(d.getHours()).toBe(1)
    expect(d.getMinutes()).toBe(14)
    expect(dd!.descriptor).toMatch(/DOORDASH/i)
  })

  it("makes the DoorDash charge the most recent transaction", () => {
    const sorted = [...data.transactions].sort((x, y) => +new Date(y.timestamp) - +new Date(x.timestamp))
    expect(sorted[0].merchant).toBe("DoorDash")
  })

  it("includes cards, payees, goals and notifications", () => {
    expect(data.cards.length).toBeGreaterThanOrEqual(2)
    expect(data.payees.length).toBeGreaterThan(0)
    expect(data.goals.length).toBeGreaterThan(0)
    expect(data.notifications.length).toBeGreaterThan(0)
  })
})

import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../../../src/server/store"
import { listTransactions, getTransaction } from "../../../src/server/transactions"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("listTransactions", () => {
  it("returns newest first and paginates by cursor", () => {
    const p1 = listTransactions({ limit: 10 })
    expect(p1.data.length).toBe(10)
    expect(+new Date(p1.data[0].timestamp)).toBeGreaterThanOrEqual(+new Date(p1.data[1].timestamp))
    expect(p1.nextCursor).toBeTruthy()
    const p2 = listTransactions({ limit: 10, cursor: p1.nextCursor! })
    expect(p2.data[0].id).not.toBe(p1.data[0].id)
  })
  it("filters by search, category, account and amount range", () => {
    expect(listTransactions({ search: "doordash" }).data.some(t => t.merchant === "DoorDash")).toBe(true)
    expect(listTransactions({ category: "dining" }).data.every(t => t.category === "dining")).toBe(true)
    expect(listTransactions({ accountId: "acc_savings" }).data.every(t => t.accountId === "acc_savings")).toBe(true)
    expect(listTransactions({ min: 100000 }).data.every(t => Math.abs(t.amount) >= 100000)).toBe(true)
  })
  it("treats a date-only `to` as through end of day, so a same-day window is not empty", () => {
    // The planted charge lands at 01:14 local on the seeded day (08:14Z).
    // `to` is documented as an inclusive date bound, so asking for that one
    // day has to return it — a bare date parses to 00:00 UTC, which used to
    // cut the whole day and hand the agent an empty 200 to narrate.
    const sameDay = listTransactions({ from: "2026-06-29", to: "2026-06-29" })
    expect(sameDay.total).toBeGreaterThan(0)
    expect(sameDay.data.some(t => t.id === "txn_doordash_87")).toBe(true)
    expect(listTransactions({ to: "2026-06-29" }).data.some(t => t.id === "txn_doordash_87")).toBe(true)
  })
  it("honours a full timestamp `to` exactly, without widening it", () => {
    const untilMidnight = listTransactions({ from: "2026-06-29", to: "2026-06-29T00:00:00.000Z" })
    expect(untilMidnight.data.some(t => t.id === "txn_doordash_87")).toBe(false)
  })
})

describe("getTransaction", () => {
  it("returns the planted charge and undefined for missing", () => {
    const dd = getTransaction("txn_doordash_87")
    expect(dd?.amount).toBe(-8700)
    expect(getTransaction("nope")).toBeUndefined()
  })
})

import { describe, it, expect, beforeAll } from "vitest"
import { placeOrder } from "./orders"
import { listTransactions } from "./transactions"
import { pacificHour } from "@/flowlet/time"
import { __reseed } from "./store"

// Freeze the store to the same fixed anchor used across the rest of the suite
// (see __tests__/*.test.ts). This is not a recurring-biller day-of-month (1, 4,
// 7, 9, 12) and is safely in the past, so no seeded "today" transaction can ever
// be newer than the late-night charge placeOrder() appends using the real
// wall-clock date — the test's freshness assertion is otherwise flaky because
// getStore() seeds relative to real "now" and a recurring charge (e.g. Equinox,
// dom=1) can land "today" and outrank the ~1 AM charge.
beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("placeOrder", () => {
  it("appends a late-night DoorDash dining charge that the read API returns", () => {
    const before = listTransactions({ limit: 1 }).data[0]?.id
    const txn = placeOrder()
    expect(txn.merchant).toBe("DoorDash")
    expect(txn.category).toBe("dining")
    expect(txn.amount).toBeLessThan(0)
    // Timestamp is in the late-night band (Pacific).
    const h = pacificHour(txn.timestamp)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(5)
    // It is now the most-recent transaction via the existing read path.
    const after = listTransactions({ limit: 1 }).data[0]
    expect(after.id).toBe(txn.id)
    expect(after.id).not.toBe(before)
  })
})

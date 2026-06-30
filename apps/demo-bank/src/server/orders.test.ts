import { describe, it, expect } from "vitest"
import { placeOrder } from "./orders"
import { listTransactions } from "./transactions"
import { pacificHour } from "@/flowlet/time"

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

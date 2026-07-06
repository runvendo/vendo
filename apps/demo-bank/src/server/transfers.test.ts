import { describe, it, expect, beforeAll } from "vitest"
import { transferMoney } from "./transfers"
import { listTransactions } from "./transactions"
import { getStore, __reseed } from "./store"

// Freeze the store to a fixed, safely-past anchor (same discipline as
// orders.test.ts) so the appended transfer is always the newest row.
beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("transferMoney", () => {
  it("debits checking and appends a posted transfer the read API returns", () => {
    const store = getStore()
    const checking = store.accounts.find((a) => a.kind === "checking")!
    const before = checking.balance

    const txn = transferMoney({ amount: 50000, recipientName: "Alex Rivera", memo: "June rent" })

    expect(txn.category).toBe("transfer")
    expect(txn.amount).toBe(-50000)
    expect(txn.merchant).toBe("Alex Rivera")
    expect(txn.notes).toBe("June rent")
    // The money actually left the checking balance (in-memory demo store).
    expect(checking.balance).toBe(before - 50000)
    // It is now the most-recent transaction via the existing read path.
    expect(listTransactions({ limit: 1 }).data[0].id).toBe(txn.id)
  })
})

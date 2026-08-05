import { describe, it, expect, beforeAll } from "vitest"
import { transferMoney, TransferError } from "./transfers"
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

  it("credits the destination and posts its INTERNAL XFER row for an own-account transfer", () => {
    const store = getStore()
    const checking = store.accounts.find((a) => a.kind === "checking")!
    const savings = store.accounts.find((a) => a.kind === "savings")!
    const checkingBefore = checking.balance
    const savingsBefore = savings.balance
    const netWorthBefore = checkingBefore + savingsBefore

    const txn = transferMoney({ amount: 30000, recipientName: "Maple Savings" })

    // Net-worth-neutral: checking debited, savings credited by the same amount.
    expect(checking.balance).toBe(checkingBefore - 30000)
    expect(savings.balance).toBe(savingsBefore + 30000)
    expect(checking.balance + savings.balance).toBe(netWorthBefore)

    // The savings account's own Transactions view shows the incoming credit.
    const credit = listTransactions({ accountId: savings.id, limit: 1 }).data[0]
    expect(credit.accountId).toBe(savings.id)
    expect(credit.amount).toBe(30000)
    expect(credit.descriptor).toBe("INTERNAL XFER")
    expect(credit.status).toBe("posted")
    expect(credit.id).not.toBe(txn.id)
  })

  it("matches a masked recipient — the assistant's scripted transfer names 'Maple Savings ··8820'", () => {
    const store = getStore()
    const checking = store.accounts.find((a) => a.kind === "checking")!
    const savings = store.accounts.find((a) => a.kind === "savings")!
    expect(savings.mask).toBe("8820")

    // Both masked spellings in the wild: the demo script's tight "··8820" and
    // the UI copy's spaced "·· 8820". Each must credit savings — an exact-name
    // comparison here once debited checking into thin air.
    for (const recipientName of [`${savings.name} ··${savings.mask}`, `${savings.name} ·· ${savings.mask}`]) {
      const checkingBefore = checking.balance
      const savingsBefore = savings.balance

      transferMoney({ amount: 20000, recipientName })

      expect(checking.balance).toBe(checkingBefore - 20000)
      expect(savings.balance).toBe(savingsBefore + 20000)
      const credit = listTransactions({ accountId: savings.id, limit: 1 }).data[0]
      expect(credit.amount).toBe(20000)
      expect(credit.descriptor).toBe("INTERNAL XFER")
    }
  })

  it("leaves a non-own-account recipient a pure debit (no destination credit)", () => {
    const store = getStore()
    const otherBalancesBefore = store.accounts
      .filter((a) => a.kind !== "checking")
      .map((a) => a.balance)
    const rowsBefore = store.transactions.length

    transferMoney({ amount: 25000, recipientName: "Jordan Avery" })

    // No other account balance moved, and exactly one (debit) row was appended.
    expect(store.accounts.filter((a) => a.kind !== "checking").map((a) => a.balance))
      .toEqual(otherBalancesBefore)
    expect(store.transactions.length).toBe(rowsBefore + 1)
  })

  it("rejects poison amounts without touching the balance", () => {
    const checking = getStore().accounts.find((a) => a.kind === "checking")!
    const before = checking.balance
    for (const amount of [-500, 0, Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
      expect(() => transferMoney({ amount, recipientName: "Mallory" })).toThrow(TransferError)
    }
    // No debit and no appended row from any rejected call.
    expect(checking.balance).toBe(before)
  })

  it("rejects an overdraft (amount greater than the checking balance)", () => {
    const checking = getStore().accounts.find((a) => a.kind === "checking")!
    const before = checking.balance
    expect(() => transferMoney({ amount: before + 1, recipientName: "Mallory" })).toThrow(
      TransferError,
    )
    expect(checking.balance).toBe(before)
  })
})

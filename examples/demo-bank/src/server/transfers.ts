import { getStore } from "./store"
import type { Transaction } from "./types"

/** Sends demo money by debiting checking and appending a posted transfer; no real money moves. */
export interface TransferMoneyInput {
  amount?: number // cents
  recipientName?: string
  memo?: string
}

/** Caller-facing rejection (bad amount / overdraft). The route maps it to a
 *  clean 400 the agent can relay; anything else is a real bug and rethrows. */
export class TransferError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransferError"
  }
}

let transferCounter = 0

export function transferMoney(input: TransferMoneyInput = {}): Transaction {
  const store = getStore()
  const checking = store.accounts.find((a) => a.kind === "checking")
  const account = checking ?? store.accounts[0]
  const accountId = account?.id ?? "acct_checking"

  const amount = input.amount ?? 0
  // Validate BEFORE any mutation: a finite positive integer number of cents.
  // Rejects negatives (which would credit), zero, fractional cents, and the
  // NaN/Infinity a non-numeric or out-of-range query param coerces to.
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TransferError("Amount must be a positive whole number of cents.")
  }
  const balance = account?.balance ?? 0
  if (amount > balance) {
    throw new TransferError("Insufficient funds for this transfer.")
  }
  const recipient = input.recipientName?.trim() || "Payee"
  const ref = 4100 + ((transferCounter * 17) % 900)
  transferCounter++

  // Debit the account (the demo's "money actually left" moment).
  if (account) account.balance -= amount

  const txn: Transaction = {
    id: `txn_transfer_${Date.now()}`,
    accountId,
    merchant: recipient,
    descriptor: `MAPLE TRANSFER TO ${recipient.toUpperCase()} REF ${ref}`,
    amount: -amount,
    timestamp: new Date().toISOString(),
    category: "transfer",
    status: "posted",
    statusTimeline: [{ state: "posted", at: new Date().toISOString() }],
    method: "Maple Checking ·· 4471",
    notes: input.memo?.trim() || undefined,
  }

  store.transactions.unshift(txn)
  store.transactions.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
  return txn
}

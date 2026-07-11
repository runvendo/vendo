import { getStore } from "./store"
import type { Transaction } from "./types"

/** Places a delivery order transaction at a pinned late-night Pacific timestamp. */
export interface PlaceOrderInput {
  merchant?: string
  amountCents?: number
  descriptor?: string
  items?: string
  hour?: number
  minute?: number
}

function lateNightPacificISO(hour = 1, minute = 32): string {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()) // YYYY-MM-DD in Pacific
  const hh = String(hour).padStart(2, "0")
  const mm = String(minute).padStart(2, "0")
  return `${dateStr}T${hh}:${mm}:00-07:00`
}

let orderCounter = 0

export function placeOrder(input: PlaceOrderInput = {}): Transaction {
  const store = getStore()
  const checking = store.accounts.find((a) => a.kind === "checking")
  const accountId = checking?.id ?? store.accounts[0]?.id ?? "acct_checking"

  const minute = input.minute ?? 18 + ((orderCounter * 7) % 40)
  const orderNo = 9900 + ((orderCounter * 13) % 99)
  orderCounter++

  const txn: Transaction = {
    id: `txn_latenight_${Date.now()}`,
    accountId,
    cardId: "card_physical",
    merchant: input.merchant ?? "DoorDash",
    descriptor: input.descriptor ?? `DOORDASH*ORDER ${orderNo} CA`,
    amount: -(input.amountCents ?? 3184),
    timestamp: lateNightPacificISO(input.hour ?? 1, minute),
    category: "dining",
    status: "posted",
    statusTimeline: [{ state: "posted", at: new Date().toISOString() }],
    method: "Maple Debit ·· 4471",
    location: "San Francisco, CA",
    notes: input.items ?? "Taco Bell · late-night delivery",
  }

  store.transactions.unshift(txn)
  store.transactions.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
  return txn
}

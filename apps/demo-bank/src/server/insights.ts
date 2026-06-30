import { getStore } from "./store"
import type { SpendingSlice, Budget, CashflowPoint, Recurring, Category, Transaction } from "./types"

function thisMonth(t: Transaction, now = new Date()) {
  const d = new Date(t.timestamp)
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
}
function monthAnchor() {
  const txns = getStore().transactions
  return txns.length ? new Date(txns[0].timestamp) : new Date()
}

export function spendingByCategory(): SpendingSlice[] {
  const now = monthAnchor()
  const sums = new Map<Category, number>()
  for (const t of getStore().transactions) {
    if (t.amount >= 0) continue
    if (!thisMonth(t, now)) continue
    if (t.category === "transfer") continue
    sums.set(t.category, (sums.get(t.category) ?? 0) + Math.abs(t.amount))
  }
  return [...sums.entries()].map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
}

const BUDGET_LIMITS: Partial<Record<Category, number>> = {
  dining: 60000, groceries: 50000, coffee: 12000, transport: 30000,
  shopping: 60000, subscriptions: 12000,
}
export function budgets(): Budget[] {
  const spend = new Map(spendingByCategory().map(s => [s.category, s.amount]))
  return Object.entries(BUDGET_LIMITS).map(([category, limit]) => ({
    category: category as Category, limit: limit!, spent: spend.get(category as Category) ?? 0,
  }))
}

export function cashflow(): CashflowPoint[] {
  const byMonth = new Map<string, { in: number; out: number }>()
  for (const t of getStore().transactions) {
    if (t.category === "transfer") continue
    const d = new Date(t.timestamp)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const cur = byMonth.get(key) ?? { in: 0, out: 0 }
    if (t.amount >= 0) cur.in += t.amount; else cur.out += Math.abs(t.amount)
    byMonth.set(key, cur)
  }
  return [...byMonth.entries()].sort().map(([label, v]) => ({ label, ...v }))
}

export function recurring(): Recurring[] {
  const seen = new Map<string, Recurring>()
  for (const t of getStore().transactions) {
    if (!t.recurringId || t.amount >= 0) continue
    if (!seen.has(t.recurringId)) {
      const next = new Date(t.timestamp); next.setMonth(next.getMonth() + 1)
      seen.set(t.recurringId, { id: t.recurringId, merchant: t.merchant, amount: t.amount,
        cadence: "monthly", category: t.category, nextDate: next.toISOString() })
    }
  }
  return [...seen.values()].sort((a, b) => a.amount - b.amount)
}

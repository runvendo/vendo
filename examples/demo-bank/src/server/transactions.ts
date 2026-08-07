import { getStore } from "./store"
import type { Transaction, Category, TxStatus } from "./types"

export interface TxQuery {
  search?: string; category?: Category; accountId?: string; cardId?: string
  status?: TxStatus; from?: string; to?: string; min?: number; max?: number
  sort?: "newest" | "oldest" | "amount"; limit?: number; cursor?: string
}
export interface Page<T> { data: T[]; nextCursor?: string; total: number }

export function listTransactions(q: TxQuery = {}): Page<Transaction> {
  let rows = getStore().transactions.slice()
  if (q.search) {
    const s = q.search.toLowerCase()
    rows = rows.filter(t => t.merchant.toLowerCase().includes(s) || t.descriptor.toLowerCase().includes(s))
  }
  if (q.category) rows = rows.filter(t => t.category === q.category)
  if (q.accountId) rows = rows.filter(t => t.accountId === q.accountId)
  if (q.cardId) rows = rows.filter(t => t.cardId === q.cardId)
  if (q.status) rows = rows.filter(t => t.status === q.status)
  if (q.from) rows = rows.filter(t => +new Date(t.timestamp) >= +new Date(q.from!))
  if (q.to) rows = rows.filter(t => +new Date(t.timestamp) <= +new Date(q.to!))
  if (q.min != null) rows = rows.filter(t => Math.abs(t.amount) >= q.min!)
  if (q.max != null) rows = rows.filter(t => Math.abs(t.amount) <= q.max!)

  if (q.sort === "oldest") rows.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
  else if (q.sort === "amount") rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  else rows.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))

  const total = rows.length
  const limit = q.limit ?? 25
  const start = q.cursor ? Math.max(0, rows.findIndex(t => t.id === q.cursor)) : 0
  const slice = rows.slice(start, start + limit)
  const next = rows[start + limit]
  return { data: slice, nextCursor: next?.id, total }
}

export function getTransaction(id: string): Transaction | undefined {
  return getStore().transactions.find(t => t.id === id)
}

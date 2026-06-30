"use client"
import * as React from "react"
import { Download, Inbox } from "lucide-react"
import type { Transaction } from "@/server/types"
import { useTransactions } from "@/lib/hooks"
import { formatAmount } from "@/lib/money"
import { relativeDay } from "@/lib/format"
import { categoryLabel } from "@/components/charts/colors"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { TransactionRow } from "@/components/transactions/transaction-row"
import { FiltersBar, DEFAULT_FILTERS, type Filters } from "@/components/transactions/filters-bar"

const PAGE_SIZE = 25

function buildQs(f: Filters, cursor?: string) {
  const p = new URLSearchParams()
  if (f.search) p.set("search", f.search)
  if (f.category !== "all") p.set("category", f.category)
  if (f.accountId !== "all") p.set("accountId", f.accountId)
  if (f.status !== "all") p.set("status", f.status)
  p.set("sort", f.sort)
  p.set("limit", String(PAGE_SIZE))
  if (cursor) p.set("cursor", cursor)
  return `?${p.toString()}`
}

function groupByDay(rows: Transaction[]) {
  const groups: { day: string; rows: Transaction[] }[] = []
  for (const t of rows) {
    const day = relativeDay(t.timestamp)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.rows.push(t)
    else groups.push({ day, rows: [t] })
  }
  return groups
}

function toCsv(rows: Transaction[]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
  const header = ["Date", "Merchant", "Descriptor", "Category", "Amount"]
  const lines = rows.map((t) =>
    [
      new Date(t.timestamp).toISOString(),
      t.merchant,
      t.descriptor,
      categoryLabel(t.category),
      (t.amount / 100).toFixed(2),
    ].map((c) => esc(String(c))).join(","),
  )
  return [header.join(","), ...lines].join("\n")
}

export default function TransactionsPage() {
  const toast = useToast()
  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS)
  const [cursor, setCursor] = React.useState<string | undefined>(undefined)
  const [rows, setRows] = React.useState<Transaction[]>([])

  const qs = React.useMemo(() => buildQs(filters, cursor), [filters, cursor])
  const { data, isLoading, error } = useTransactions(qs)

  // Merge fetched pages into the accumulated list. cursor undefined = fresh page.
  React.useEffect(() => {
    if (!data) return
    if (!cursor) {
      setRows(data.data)
    } else {
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        return [...prev, ...data.data.filter((r) => !seen.has(r.id))]
      })
    }
  }, [data, cursor])

  const applyFilters = (f: Filters) => {
    setFilters(f)
    setCursor(undefined)
    setRows([])
  }

  const net = rows.reduce((sum, t) => sum + t.amount, 0)
  const total = data?.total ?? 0
  const groups = groupByDay(rows)

  const showInitialLoading = isLoading && rows.length === 0
  const showEmpty = !isLoading && rows.length === 0 && data?.total === 0
  const showError = !!error && rows.length === 0

  const onExport = () => {
    const csv = toCsv(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "maple-transactions.csv"
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast({ title: "Exported", description: "CSV downloaded." })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Transactions</h1>
          <p className="text-sm text-muted">Search, filter, and export your activity.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onExport} disabled={rows.length === 0}>
          <Download className="h-4 w-4" />
          Export
        </Button>
      </div>

      <FiltersBar value={filters} onChange={applyFilters} />

      <Card>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="text-[13px] text-muted tabular-nums">
            {showInitialLoading ? (
              <Skeleton className="h-3.5 w-44" />
            ) : (
              <>
                <span className="font-medium text-ink">{total.toLocaleString()}</span>{" "}
                {total === 1 ? "transaction" : "transactions"}
                <span className="px-1.5 text-border-strong">·</span>
                net <span className="font-medium text-ink">{formatAmount(net)}</span>
                {rows.length < total && (
                  <span className="ml-1 text-muted">(showing {rows.length})</span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-1.5 py-2">
          {showInitialLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-2.5 py-3">
                  <Skeleton className="h-9 w-9 rounded-[10px]" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-44" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : showError ? (
            <EmptyState
              title="Couldn't load transactions"
              hint="Something went wrong. Try adjusting your filters."
              onClear={() => applyFilters(DEFAULT_FILTERS)}
            />
          ) : showEmpty ? (
            <EmptyState
              title="No transactions match your filters."
              hint="Try a different search or clear the filters."
              onClear={() => applyFilters(DEFAULT_FILTERS)}
            />
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    {g.day}
                  </div>
                  <div className="flex flex-col">
                    {g.rows.map((t) => (
                      <TransactionRow key={t.id} t={t} showTime />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {data?.nextCursor && rows.length > 0 && (
          <div className="flex justify-center border-t border-border px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={isLoading}
              onClick={() => setCursor(data.nextCursor)}
            >
              {isLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

function EmptyState({
  title, hint, onClear,
}: {
  title: string
  hint: string
  onClear: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
        <Inbox className="h-5 w-5" />
      </div>
      <div className="mt-4 text-sm font-medium text-ink">{title}</div>
      <div className="mt-1 max-w-xs text-sm text-muted">{hint}</div>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}

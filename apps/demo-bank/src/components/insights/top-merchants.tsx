"use client"
import * as React from "react"
import { useTransactions } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

interface MerchantTotal {
  merchant: string
  total: number
  count: number
}

export function TopMerchants() {
  const { data, isLoading } = useTransactions("?limit=200")

  const merchants = React.useMemo<MerchantTotal[]>(() => {
    const rows = data?.data ?? []
    const byMerchant = new Map<string, MerchantTotal>()
    for (const t of rows) {
      if (t.amount >= 0) continue
      if (t.category === "transfer" || t.category === "income") continue
      const prev = byMerchant.get(t.merchant) ?? { merchant: t.merchant, total: 0, count: 0 }
      prev.total += Math.abs(t.amount)
      prev.count += 1
      byMerchant.set(t.merchant, prev)
    }
    return [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, 6)
  }, [data])

  const max = Math.max(...merchants.map((m) => m.total), 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top merchants</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !data ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-4 shrink-0" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3.5 w-16 shrink-0" />
            </div>
          ))
        ) : (
          merchants.map((m, i) => (
            <div key={m.merchant} className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-right text-[13px] tabular-nums text-muted">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-ink">{m.merchant}</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">
                    {formatUSD(m.total)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-1.5 rounded-full bg-ink/70"
                    style={{ width: `${Math.min(100, (m.total / max) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-muted tabular-nums">
                  {m.count} {m.count === 1 ? "transaction" : "transactions"}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

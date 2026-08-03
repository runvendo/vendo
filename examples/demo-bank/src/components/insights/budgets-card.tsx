"use client"
import { useBudgets } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { categoryLabel } from "@/components/charts/colors"

export function BudgetsCard() {
  const { data, isLoading } = useBudgets()

  const budgets = [...(data ?? [])].sort((a, b) => {
    const pa = a.limit > 0 ? a.spent / a.limit : 0
    const pb = b.limit > 0 ? b.spent / b.limit : 0
    return pb - pa
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-28" />
              </div>
              <Skeleton className="h-2 w-full" />
            </div>
          ))
        ) : (
          budgets.map((b) => {
            const ratio = b.limit > 0 ? b.spent / b.limit : 0
            const pct = Math.min(100, ratio * 100)
            const over = b.spent > b.limit
            return (
              <div key={b.category} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium text-ink">
                      {categoryLabel(b.category)}
                    </span>
                    {over && <Badge tone="negative">Over</Badge>}
                  </div>
                  <div className="shrink-0 text-[13px] tabular-nums text-muted">
                    <span className={over ? "font-medium text-neg" : "font-medium text-ink"}>
                      {formatUSD(b.spent)}
                    </span>
                    {" / "}
                    {formatUSD(b.limit)}
                    <span className="ml-1.5 text-border-strong">·</span>
                    <span className="ml-1.5">{Math.round(ratio * 100)}%</span>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-2 rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: over ? "var(--color-neg)" : "var(--color-ink)",
                    }}
                  />
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

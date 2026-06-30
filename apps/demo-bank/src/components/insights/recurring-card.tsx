"use client"
import { useRecurring } from "@/lib/hooks"
import { formatUSD, formatAmount } from "@/lib/money"
import { formatDate } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { categoryColor } from "@/components/charts/colors"
import { BrandLogo } from "@/components/ui/brand-logo"
import { domainForName } from "@/lib/logos"

export function RecurringCard() {
  const { data, isLoading } = useRecurring()

  const monthlyTotal = (data ?? []).reduce((sum, r) => sum + Math.abs(r.amount), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recurring &amp; subscriptions</CardTitle>
        {isLoading || !data ? (
          <Skeleton className="h-3.5 w-20" />
        ) : (
          <span className="text-[13px] tabular-nums text-muted">
            <span className="font-medium text-ink">{formatUSD(monthlyTotal)}</span>/mo
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading || !data ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))
        ) : (
          data.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <BrandLogo domain={domainForName(r.merchant)} alt={r.merchant} size={28}
                  fallback={
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: categoryColor(r.category) }}
                    />
                  } />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{r.merchant}</div>
                  <div className="text-xs text-muted capitalize">
                    {r.cadence} · next {formatDate(r.nextDate)}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                {formatAmount(r.amount)}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

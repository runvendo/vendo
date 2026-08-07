"use client"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useScheduled } from "@/lib/hooks"
import { formatAmount } from "@/lib/money"
import { relativeDay } from "@/lib/format"

export function ScheduledList() {
  const { data, isLoading } = useScheduled()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled &amp; recurring</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-2.5">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))
        ) : data.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted">No scheduled payments.</div>
        ) : (
          data.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">{p.payeeName}</div>
                <div className="text-xs capitalize text-muted">
                  {relativeDay(p.nextDate)} · {p.cadence}
                </div>
              </div>
              <div className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                {formatAmount(p.amount)}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

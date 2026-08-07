"use client"
import { useScheduled } from "@/lib/hooks"
import { formatAmount } from "@/lib/money"
import { relativeDay } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function UpcomingBills() {
  const { data, isLoading } = useScheduled()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading || !data ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-2">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))
        ) : (
          data.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">{p.payeeName}</div>
                <div className="text-xs text-muted capitalize">
                  {relativeDay(p.nextDate)} · {p.cadence}
                </div>
              </div>
              <div className="text-sm font-semibold tabular-nums text-ink">
                {formatAmount(p.amount)}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

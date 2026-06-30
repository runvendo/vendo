"use client"
import { useSpending } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Donut } from "@/components/charts/donut"
import { categoryColor, categoryLabel } from "@/components/charts/colors"

export function SpendingMini() {
  const { data, isLoading } = useSpending()
  const top = data?.slice(0, 4) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spending</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <div className="flex items-center gap-5">
            <Skeleton className="h-[150px] w-[150px] rounded-full" />
            <div className="flex-1 space-y-2.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-5">
            <Donut data={data} size={150} />
            <ul className="flex-1 space-y-2">
              {top.map((s) => (
                <li key={s.category} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: categoryColor(s.category) }}
                  />
                  <span className="flex-1 truncate text-ink">{categoryLabel(s.category)}</span>
                  <span className="tabular-nums text-muted">{formatUSD(s.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

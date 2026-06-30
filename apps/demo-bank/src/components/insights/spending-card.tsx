"use client"
import { useSpending } from "@/lib/hooks"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Donut } from "@/components/charts/donut"
import { Bars } from "@/components/charts/bars"
import { categoryColor, categoryLabel } from "@/components/charts/colors"

export function SpendingCard() {
  const { data, isLoading } = useSpending()

  const items =
    data?.map((s) => ({
      label: categoryLabel(s.category),
      value: s.amount,
      color: categoryColor(s.category),
    })) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spending by category</CardTitle>
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted font-medium">
          This month
        </span>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-8">
            <Skeleton className="h-[200px] w-[200px] shrink-0 rounded-full" />
            <div className="w-full flex-1 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-2 w-full" />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-8">
            <Donut data={data} size={200} className="shrink-0" />
            <Bars items={items} className="w-full flex-1" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

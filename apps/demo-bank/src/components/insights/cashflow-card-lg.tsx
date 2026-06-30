"use client"
import { useCashflow } from "@/lib/hooks"
import { formatUSD, formatAmount } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CashflowBars } from "@/components/charts/cashflow-bars"

export function CashflowCardLarge() {
  const { data, isLoading } = useCashflow()
  const latest = data && data.length > 0 ? data[data.length - 1] : undefined
  const net = latest ? latest.in - latest.out : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash flow</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data || !latest ? (
          <div className="space-y-4">
            <div className="flex gap-8">
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
            </div>
            <Skeleton className="h-[220px] w-full" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <Stat label="In" value={formatUSD(latest.in)} className="text-pos" />
              <Stat label="Out" value={formatUSD(latest.out)} className="text-ink" />
              <Stat
                label="Net"
                value={formatAmount(net)}
                className={net < 0 ? "text-neg" : "text-pos"}
              />
            </div>
            <div className="mt-5">
              <CashflowBars data={data} height={220} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${className ?? "text-ink"}`}>
        {value}
      </div>
    </div>
  )
}

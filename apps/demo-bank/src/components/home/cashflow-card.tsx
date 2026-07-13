"use client"
import { useCashflow } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function CashflowCard() {
  const { data, isLoading } = useCashflow()
  const point = data && data.length > 0 ? data[data.length - 1] : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash flow</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !point ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : (
          <CashflowBody inAmt={point.in} outAmt={point.out} />
        )}
      </CardContent>
    </Card>
  )
}

function CashflowBody({ inAmt, outAmt }: { inAmt: number; outAmt: number }) {
  const total = inAmt + outAmt || 1
  const inPct = (inAmt / total) * 100
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
            Money in
          </div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-pos">
            {formatUSD(inAmt)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
            Money out
          </div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">
            {formatUSD(outAmt)}
          </div>
        </div>
      </div>
      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-hover">
        <div className="h-full bg-pos" style={{ width: `${inPct}%` }} />
        <div className="h-full bg-ink/70" style={{ width: `${100 - inPct}%` }} />
      </div>
    </div>
  )
}

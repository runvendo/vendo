"use client"
import { useState } from "react"
import { useProfile, useAccounts } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { AreaTrend } from "@/components/charts/area-trend"

type Range = "1W" | "1M" | "3M" | "1Y" | "All"
const RANGE_OPTIONS: { label: Range; value: Range }[] = [
  { label: "1W", value: "1W" },
  { label: "1M", value: "1M" },
  { label: "3M", value: "3M" },
  { label: "1Y", value: "1Y" },
  { label: "All", value: "All" },
]
const TAIL: Record<Range, number> = { "1W": 4, "1M": 8, "3M": 18, "1Y": Infinity, All: Infinity }

export function NetWorthCard() {
  const [range, setRange] = useState<Range>("3M")
  const { data: profile, isLoading: pl } = useProfile()
  const { data: accounts, isLoading: al } = useAccounts()
  const loading = pl || al

  // Net-worth series: index-sum every account's sparkline (all equal length).
  const series = (() => {
    if (!accounts || accounts.length === 0) return []
    const len = accounts[0].sparkline.length
    const summed = Array.from({ length: len }, (_, i) =>
      accounts.reduce((acc, a) => acc + (a.sparkline[i] ?? 0), 0),
    )
    const tail = TAIL[range]
    const sliced = tail === Infinity ? summed : summed.slice(-tail)
    return sliced.map((y, i) => ({ x: String(i), y }))
  })()

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
              Total balance
            </div>
            {loading || !profile ? (
              <Skeleton className="mt-2 h-10 w-56" />
            ) : (
              <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-ink">
                {formatUSD(profile.netWorth)}
              </div>
            )}
            <div className="mt-2">
              <Badge tone="positive">▲ 2.3% this month</Badge>
            </div>
          </div>
          <Segmented options={RANGE_OPTIONS} value={range} onChange={setRange} />
        </div>
        <div className="mt-4">
          {loading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : (
            <AreaTrend data={series} height={220} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

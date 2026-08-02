"use client"
import { useProfile, useAccounts } from "@/lib/hooks"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { NetWorthView } from "./net-worth-view"

/**
 * Data container for the home net-worth card. The visual card itself is the
 * presentational `NetWorthView`, which Vendo captures as a remixable slot
 * (src/vendo/registry.tsx) — this wrapper only fetches and sums.
 */
export function NetWorthCard() {
  const { data: profile, isLoading: pl } = useProfile()
  const { data: accounts, isLoading: al } = useAccounts()
  const loading = pl || al

  // Net-worth series: index-sum every account's sparkline (all equal length).
  const series = (() => {
    if (!accounts || accounts.length === 0) return []
    const len = accounts[0].sparkline.length
    return Array.from({ length: len }, (_, i) =>
      accounts.reduce((acc, a) => acc + (a.sparkline[i] ?? 0), 0),
    )
  })()

  if (loading || !profile) {
    return (
      <Card>
        <CardContent className="pt-5">
          <Skeleton className="mt-2 h-10 w-56" />
          <Skeleton className="mt-6 h-[220px] w-full" />
        </CardContent>
      </Card>
    )
  }

  return <NetWorthView valueCents={profile.netWorth} series={series} />
}

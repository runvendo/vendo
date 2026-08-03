"use client"
import Link from "next/link"
import { useAccounts } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Sparkline } from "@/components/charts/sparkline"

export function AccountsStrip() {
  const { data: accounts, isLoading } = useAccounts()

  if (isLoading || !accounts) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-28" />
            <Skeleton className="mt-4 h-7 w-full" />
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {accounts.map((a) => (
        <Link key={a.id} href={`/accounts/${a.id}`}>
          <Card hover className="flex h-full flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.08em] text-muted font-semibold">
                  {a.kind}
                </div>
                <div className="mt-0.5 truncate text-sm font-medium text-ink">{a.name}</div>
                <div className="text-xs text-muted tabular-nums">·· {a.mask}</div>
              </div>
              {a.kind === "savings" && a.apy != null && (
                <Badge tone="positive">{a.apy}% APY</Badge>
              )}
            </div>
            <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums text-ink">
              {formatUSD(a.balance)}
            </div>
            <div className="mt-3">
              <Sparkline data={a.sparkline} height={28} />
            </div>
          </Card>
        </Link>
      ))}
    </div>
  )
}

"use client"
import type { Account } from "@/server/types"
import { Badge } from "@/components/ui/badge"
import { CountUp } from "@/components/ui/count-up"
import { AreaTrend } from "@/components/charts/area-trend"
import { KIND_ICON, KIND_LABEL } from "./account-meta"

export function AccountHeader({ account }: { account: Account }) {
  const Icon = KIND_ICON[account.kind]
  const series = account.sparkline.map((y, i) => ({ x: String(i), y }))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-border bg-hover text-ink">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{account.name}</h1>
              {account.kind === "savings" && account.apy != null && (
                <Badge tone="positive">{account.apy}% APY</Badge>
              )}
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              {KIND_LABEL[account.kind]} <span className="text-border-strong">·</span> ·· {account.mask}
            </div>
          </div>
        </div>
        <CountUp
          valueCents={account.balance}
          className="text-4xl font-semibold tracking-tight tabular-nums text-ink"
        />
      </div>

      <AreaTrend data={series} height={180} />
    </div>
  )
}

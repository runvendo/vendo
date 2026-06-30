"use client"
import Link from "next/link"
import type { Account } from "@/server/types"
import { formatUSD } from "@/lib/money"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Sparkline } from "@/components/charts/sparkline"
import { KIND_ICON, KIND_LABEL } from "./account-meta"

export function AccountCard({ account }: { account: Account }) {
  const Icon = KIND_ICON[account.kind]
  return (
    <Link href={`/accounts/${account.id}`} className="block">
      <Card hover className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-border bg-hover text-ink">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              {KIND_LABEL[account.kind]} <span className="text-border-strong">·</span> ·· {account.mask}
            </div>
            <div className="mt-0.5 truncate text-sm font-medium text-ink">{account.name}</div>
          </div>
          {account.kind === "savings" && account.apy != null && (
            <Badge tone="positive">{account.apy}% APY</Badge>
          )}
        </div>

        <div>
          <div className="text-3xl font-semibold tracking-tight tabular-nums text-ink">
            {formatUSD(account.balance)}
          </div>
          {account.kind === "credit" && (
            <div className="mt-0.5 text-xs text-muted">Current balance</div>
          )}
        </div>

        <div className="mt-auto">
          <Sparkline data={account.sparkline} height={32} />
        </div>
      </Card>
    </Link>
  )
}

export function AccountCardSkeleton() {
  return (
    <Card className="flex h-full flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 rounded-[12px]" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      </div>
      <Skeleton className="h-8 w-36" />
      <Skeleton className="mt-auto h-8 w-full" />
    </Card>
  )
}

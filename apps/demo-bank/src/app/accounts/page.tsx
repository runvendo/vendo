"use client"
import { useAccounts } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Skeleton } from "@/components/ui/skeleton"
import { AccountCard, AccountCardSkeleton } from "@/components/accounts/account-card"

export default function AccountsPage() {
  const { data: accounts, isLoading } = useAccounts()
  const total = accounts?.reduce((sum, a) => sum + a.balance, 0) ?? 0

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Accounts</h1>
          <p className="text-sm text-muted">Balances across all your Maple accounts.</p>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            Total balance
          </div>
          {isLoading || !accounts ? (
            <Skeleton className="mt-1 ml-auto h-7 w-32" />
          ) : (
            <div className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-ink">
              {formatUSD(total)}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {isLoading || !accounts
          ? Array.from({ length: 4 }).map((_, i) => <AccountCardSkeleton key={i} />)
          : accounts.map((a) => <AccountCard key={a.id} account={a} />)}
      </div>
    </div>
  )
}

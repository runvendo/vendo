"use client"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ChevronLeft, Inbox } from "lucide-react"
import { useAccount, useTransactions } from "@/lib/hooks"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TransactionRow } from "@/components/transactions/transaction-row"
import { AccountHeader } from "@/components/accounts/account-header"
import { NumberReveal } from "@/components/accounts/number-reveal"
import { StatementsList } from "@/components/accounts/statements-list"

function BackLink() {
  return (
    <Link
      href="/accounts"
      className="inline-flex items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-ink"
    >
      <ChevronLeft className="h-4 w-4" />
      Accounts
    </Link>
  )
}

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { data: account, isLoading, error } = useAccount(id)

  if (error) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
            <Inbox className="h-5 w-5" />
          </div>
          <div className="mt-4 text-sm font-medium text-ink">Account not found</div>
          <div className="mt-1 max-w-xs text-sm text-muted">
            We couldn&apos;t find an account with that ID.
          </div>
          <Link href="/accounts" className="mt-4">
            <Button variant="secondary" size="sm">
              Back to accounts
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <BackLink />

      {isLoading || !account ? (
        <HeaderSkeleton />
      ) : (
        <AccountHeader account={account} />
      )}

      {account && <NumberReveal account={account} />}

      <AccountTransactions id={id} />

      <StatementsList />
    </div>
  )
}

function HeaderSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Skeleton className="h-11 w-11 rounded-[12px]" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-28" />
          </div>
        </div>
        <Skeleton className="h-10 w-44" />
      </div>
      <Skeleton className="h-[180px] w-full" />
    </div>
  )
}

function AccountTransactions({ id }: { id: string }) {
  const { data, isLoading } = useTransactions(`?accountId=${id}&limit=25`)
  const rows = data?.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
        <Link
          href={`/transactions?accountId=${id}`}
          className="text-[13px] font-medium text-muted transition-colors hover:text-ink"
        >
          View all in Transactions
        </Link>
      </CardHeader>
      <div className="border-t border-border px-1.5 py-2">
        {isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-2.5 py-3">
                <Skeleton className="h-9 w-9 rounded-[10px]" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-44" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
              <Inbox className="h-5 w-5" />
            </div>
            <div className="mt-4 text-sm font-medium text-ink">No transactions yet</div>
            <div className="mt-1 max-w-xs text-sm text-muted">
              Activity for this account will appear here.
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {rows.map((t) => (
              <TransactionRow key={t.id} t={t} showTime />
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

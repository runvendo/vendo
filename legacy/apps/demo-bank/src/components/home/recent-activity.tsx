"use client"
import Link from "next/link"
import { useTransactions } from "@/lib/hooks"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TransactionRow } from "@/components/transactions/transaction-row"

export function RecentActivity() {
  const { data, isLoading } = useTransactions("?limit=8")
  const txns = data?.data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <Link href="/transactions" className="text-[13px] font-medium text-muted hover:text-ink">
          View all
        </Link>
      </CardHeader>
      <CardContent className="px-1.5 pb-2">
        {isLoading || !txns ? (
          <div className="space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
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
        ) : (
          <div className="flex flex-col">
            {txns.map((t) => (
              <TransactionRow key={t.id} t={t} showTime />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

"use client"
import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ChevronLeft, Pencil, Check, Flag, Split, ReceiptText, FileQuestion } from "lucide-react"
import type { Category } from "@/server/types"
import { useTransaction, useAccounts } from "@/lib/hooks"
import { formatAmount } from "@/lib/money"
import { formatDate, formatTime } from "@/lib/format"
import { categoryColor, categoryLabel } from "@/components/charts/colors"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BrandLogo } from "@/components/ui/brand-logo"
import { domainForName } from "@/lib/logos"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import {
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem,
} from "@/components/ui/dropdown"
import { StatusTimeline } from "@/components/transactions/status-timeline"
import { StaticMap } from "@/components/transactions/static-map"
import { cn } from "@/lib/cn"

const CATEGORIES: Category[] = [
  "dining", "groceries", "coffee", "transport", "subscriptions",
  "shopping", "income", "transfer", "housing", "other",
]

function BackLink() {
  return (
    <Link
      href="/transactions"
      className="inline-flex items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-ink"
    >
      <ChevronLeft className="h-4 w-4" />
      Transactions
    </Link>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-sm font-medium text-ink text-right">{children}</div>
    </div>
  )
}

export default function TransactionDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const toast = useToast()
  const { data: t, isLoading, error } = useTransaction(id)
  const { data: accounts } = useAccounts()

  const [categoryOverride, setCategoryOverride] = React.useState<{ id: string; category: Category } | null>(null)

  if (isLoading || (!t && !error)) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <BackLink />
        <DetailSkeleton />
      </div>
    )
  }

  if (error || !t) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <BackLink />
        <Card>
          <CardContent className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
              <FileQuestion className="h-5 w-5" />
            </div>
            <div className="mt-4 text-base font-semibold text-ink">Transaction not found</div>
            <div className="mt-1 max-w-xs text-sm text-muted">
              We couldn&apos;t find that transaction. It may have been removed.
            </div>
            <Link href="/transactions" className="mt-5">
              <Button variant="secondary" size="sm">Back to transactions</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const credit = t.amount > 0
  const cat = categoryOverride?.id === t.id ? categoryOverride.category : t.category
  const account = accounts?.find((a) => a.id === t.accountId)
  const statusTone = t.status === "posted" ? "positive" : "neutral"
  const statusLabel = t.status.charAt(0).toUpperCase() + t.status.slice(1)
  const demo = (title: string) => toast({ title, description: "Demo only." })

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <BackLink />

      {/* Hero */}
      <div className="flex items-start gap-4">
        <BrandLogo domain={domainForName(t.merchant)} alt={t.merchant} size={56} rounded="rounded-2xl"
          fallback={
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-base font-semibold text-white"
              style={{ backgroundColor: categoryColor(cat) }}
            >
              {(t.logo ?? t.merchant.slice(0, 2)).toUpperCase()}
            </div>
          } />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-ink">{t.merchant}</h1>
            <Badge tone={statusTone}>{statusLabel}</Badge>
          </div>
          <div className="truncate text-sm text-muted">{t.descriptor}</div>
        </div>
        <div className={cn("shrink-0 text-4xl font-semibold tabular-nums", credit ? "text-pos" : "text-ink")}>
          {formatAmount(t.amount)}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
        {/* Details */}
        <Card className="md:col-span-3">
          <CardContent className="pt-5">
            <div className="divide-y divide-border">
              <Row label="Date">
                {formatDate(t.timestamp, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              </Row>
              <Row label="Time">{formatTime(t.timestamp)}</Row>
              <Row label="Category">
                <Dropdown>
                  <DropdownTrigger asChild>
                    <button className="group inline-flex items-center gap-2 rounded-lg px-2 py-1 -my-1 transition-colors hover:bg-hover">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: categoryColor(cat) }}
                      />
                      <span>{categoryLabel(cat)}</span>
                      <Pencil className="h-3 w-3 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  </DropdownTrigger>
                  <DropdownContent align="end" className="max-h-[320px] overflow-auto">
                    {CATEGORIES.map((c) => (
                      <DropdownItem
                        key={c}
                        onSelect={() => {
                          setCategoryOverride({ id: t.id, category: c })
                          toast({ title: "Category updated", description: "Demo only" })
                        }}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: categoryColor(c) }}
                        />
                        <span className="flex-1">{categoryLabel(c)}</span>
                        {c === cat && <Check className="h-3.5 w-3.5 text-ink" />}
                      </DropdownItem>
                    ))}
                  </DropdownContent>
                </Dropdown>
              </Row>
              <Row label="Account">{account?.name ?? "—"}</Row>
              <Row label="Payment method">{t.method}</Row>
              <Row label="Status">{statusLabel}</Row>
              {t.location && <Row label="Location">{t.location}</Row>}
              {t.notes && <Row label="Note">{t.notes}</Row>}
            </div>
          </CardContent>
        </Card>

        {/* Timeline */}
        <Card className="md:col-span-2">
          <CardContent className="pt-5">
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Status
            </div>
            <StatusTimeline steps={t.statusTimeline} />
          </CardContent>
        </Card>
      </div>

      {/* Location map */}
      {t.location && <StaticMap location={t.location} />}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => demo("Report a problem")}>
          <Flag className="h-4 w-4" />
          Report a problem
        </Button>
        <Button variant="secondary" size="sm" onClick={() => demo("Split transaction")}>
          <Split className="h-4 w-4" />
          Split
        </Button>
        <Button variant="secondary" size="sm" onClick={() => demo("Download receipt")}>
          <ReceiptText className="h-4 w-4" />
          Download receipt
        </Button>
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <>
      <div className="flex items-start gap-4">
        <Skeleton className="h-14 w-14 rounded-2xl" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
        <Card className="md:col-span-3">
          <CardContent className="space-y-4 pt-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-32" />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-36" />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

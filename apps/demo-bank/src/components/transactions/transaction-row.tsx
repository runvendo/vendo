"use client"
import Link from "next/link"
import { openVendoConversation } from "@vendoai/ui/chrome"
import type { Transaction } from "@/server/types"
import { formatAmount } from "@/lib/money"
import { relativeDay, formatTime } from "@/lib/format"
import { categoryColor, categoryLabel } from "@/components/charts/colors"
import { Badge } from "@/components/ui/badge"
import { BrandLogo } from "@/components/ui/brand-logo"
import { domainForName } from "@/lib/logos"
import { cn } from "@/lib/cn"

export function TransactionRow({ t, showTime }: { t: Transaction; showTime?: boolean }) {
  const credit = t.amount > 0
  return (
    <Link
      href={`/transactions/${t.id}`}
      className="group flex items-center gap-3 px-4 py-3 hover:bg-hover transition-colors rounded-lg"
    >
      <BrandLogo domain={domainForName(t.merchant)} alt={t.merchant} size={36}
        fallback={<div className="h-9 w-9 shrink-0 rounded-[10px] flex items-center justify-center text-[11px] font-semibold text-white" style={{ backgroundColor: categoryColor(t.category) }}>{(t.logo ?? t.merchant.slice(0, 2)).toUpperCase()}</div>} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink truncate">{t.merchant}</div>
        <div className="text-xs text-muted truncate">
          {relativeDay(t.timestamp)}{showTime ? ` · ${formatTime(t.timestamp)}` : ""} · {categoryLabel(t.category)}
        </div>
      </div>
      {/* demo-refresh Part 4 — quiet hover affordance: the same programmatic
          seam VendoTrigger uses (openVendoConversation), custom-styled so it
          reads as a Maple text button. Prefills the overlay, never sends;
          preventDefault keeps the row's navigation from firing. */}
      <button
        type="button"
        aria-label={`Ask Maple about ${t.merchant}`}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openVendoConversation({
            prompt: `What is this charge, and how does it compare to my usual spending with this merchant?\n\nTransaction: ${t.merchant} · ${formatAmount(t.amount)} · ${relativeDay(t.timestamp)} · ${categoryLabel(t.category)}`,
          })
        }}
      >
        Ask Maple
      </button>
      {t.status !== "posted" && <Badge tone="neutral">{t.status}</Badge>}
      <div className={cn("text-sm font-semibold tabular-nums", credit ? "text-pos" : "text-ink")}>
        {formatAmount(t.amount)}
      </div>
    </Link>
  )
}

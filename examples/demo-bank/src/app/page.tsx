"use client"
import { QuickActions } from "@/components/home/quick-actions"
import { NetWorthCard } from "@/components/home/net-worth-card"
import { AccountsStrip } from "@/components/home/accounts-strip"
import { RecentActivity } from "@/components/home/recent-activity"
import { CashflowCard } from "@/components/home/cashflow-card"
import { UpcomingBills } from "@/components/home/upcoming-bills"
import { GoalsCard } from "@/components/home/goals-card"
import { VendoCard } from "@/components/home/vendo-card"

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Overview</h1>
        <p className="text-sm text-muted">Here&apos;s where your money stands today.</p>
      </div>
      <QuickActions />
      {/* Hero row: the Total balance chart and the "home-hero" Vendo slot
          split the row 50/50 — the slot is where a pinned Maple view lands. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <NetWorthCard />
        <VendoCard />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <AccountsStrip />
          <RecentActivity />
        </div>
        <div className="space-y-6">
          <CashflowCard />
          <UpcomingBills />
          <GoalsCard />
        </div>
      </div>
    </div>
  )
}

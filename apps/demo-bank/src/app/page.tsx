"use client"
import { QuickActions } from "@/components/home/quick-actions"
import { NetWorthCard } from "@/components/home/net-worth-card"
import { AccountsStrip } from "@/components/home/accounts-strip"
import { RecentActivity } from "@/components/home/recent-activity"
import { CashflowCard } from "@/components/home/cashflow-card"
import { UpcomingBills } from "@/components/home/upcoming-bills"
import { GoalsCard } from "@/components/home/goals-card"
import { FlowletCard } from "@/components/home/flowlet-card"

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Overview</h1>
        <p className="text-sm text-muted">Here&apos;s where your money stands today.</p>
      </div>
      <QuickActions />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <NetWorthCard />
          <AccountsStrip />
          <RecentActivity />
        </div>
        <div className="space-y-6">
          <FlowletCard />
          <CashflowCard />
          <UpcomingBills />
          <GoalsCard />
        </div>
      </div>
    </div>
  )
}

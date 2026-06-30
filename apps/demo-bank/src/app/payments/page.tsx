"use client"
import { MoveMoneyTabs } from "@/components/payments/move-money-tabs"
import { PayeesList } from "@/components/payments/payees-list"
import { ScheduledList } from "@/components/payments/scheduled-list"

export default function PaymentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Payments</h1>
        <p className="text-sm text-muted">Move money, pay bills, manage payees.</p>
      </div>

      <MoveMoneyTabs />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PayeesList />
        <ScheduledList />
      </div>
    </div>
  )
}

"use client"
import { SpendingCard } from "@/components/insights/spending-card"
import { BudgetsCard } from "@/components/insights/budgets-card"
import { RecurringCard } from "@/components/insights/recurring-card"
import { CashflowCardLarge } from "@/components/insights/cashflow-card-lg"
import { TopMerchants } from "@/components/insights/top-merchants"

export default function InsightsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Insights</h1>
        <p className="text-sm text-muted">Where your money goes.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <SpendingCard />
        </div>

        <BudgetsCard />
        <RecurringCard />

        <div className="lg:col-span-2">
          <CashflowCardLarge />
        </div>

        <div className="lg:col-span-2">
          <TopMerchants />
        </div>
      </div>
    </div>
  )
}

"use client"
import { VendoSlot, VendoTrigger } from "@vendoai/ui/chrome"
import { useSpending } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { categoryLabel } from "@/components/charts/colors"
import { SpendingCard } from "@/components/insights/spending-card"
import { BudgetsCard } from "@/components/insights/budgets-card"
import { RecurringCard } from "@/components/insights/recurring-card"
import { CashflowCardLarge } from "@/components/insights/cashflow-card-lg"
import { TopMerchants } from "@/components/insights/top-merchants"

export default function InsightsPage() {
  // demo-refresh Part 4 — the trigger carries the page's visible aggregates so
  // the agent starts oriented on what the user is looking at.
  const { data: spending } = useSpending()
  const monthContext = spending?.length
    ? `This month's spending by category: ${spending
        .map((s) => `${categoryLabel(s.category)} ${formatUSD(s.amount)}`)
        .join(", ")}`
    : undefined
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Insights</h1>
          <p className="text-sm text-muted">Where your money goes.</p>
        </div>
        {/* Opens the overlay with the question prefilled — never auto-sent. */}
        <VendoTrigger
          prompt="Walk me through this month's spending: what changed, what's unusual, and where I could save."
          context={monthContext}
        >
          Ask about this month
        </VendoTrigger>
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

        {/* Remix moved to the presentational NetWorthView on Home (2026-08-02
            final shape: remix always means fork, and a fork runs in the jail —
            TopMerchants fetches its own data through host hooks, which cannot
            cross the frame boundary; the full demo conversion is lane W1e). */}
        <div className="lg:col-span-2">
          <TopMerchants />
        </div>

        {/* demo-refresh Part 4 — a labeled EMPTY slot (ghost + suggestions) so
            the save-as-app beat lands inside the page; mirrors Home's
            "Custom view" slot section. */}
        <section aria-label="Your custom view" className="space-y-2 lg:col-span-2">
          <h3 className="text-sm font-semibold text-ink">Your custom view</h3>
          <VendoSlot
            id="insights-custom-view"
            emptyState={{
              suggestions: [
                "Track my dining spend vs last month",
                "A bills-due-soon watchlist",
                "Savings goals progress",
              ],
            }}
          />
        </section>
      </div>
    </div>
  )
}
